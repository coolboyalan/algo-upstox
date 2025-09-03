import cron from "node-cron";
import express from "express";
import axios from "axios";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import sequelize from "#configs/database";
import { main, findImmediateOption } from "#utils/assetChecker";
import BrokerKey from "#models/brokerKey";
import Broker from "#models/broker";
import TradeLog from "#models/tradeLog";
import { logInfo, logWarn, logError } from "./utils/logger.js";

// Bootstrap
try {
  await sequelize.authenticate();
  logInfo("Database connected", {
    dialect: sequelize.getDialect && sequelize.getDialect(),
  });
} catch (e) {
  logError("Cannot connect", e);
  process.exit(1);
}
await main();

let dailyAsset = null;
let keys = null;
let adminKeys = null;
let dailyLevels = null;

const server = express();
const dayMap = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

// Helper: Kite-compatible IST timestamp: "YYYY-MM-DD HH:mm:00"
function toKiteISTFormat(dateObj) {
  const local = new Date(
    dateObj.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  const hh = String(local.getHours()).padStart(2, "0");
  const min = String(local.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

async function exitOpenTrades(targetKeys) {
  for (let key of targetKeys) {
    const placeIntradayOrder = async ({
      instrument_key,
      transaction_type = "BUY",
      quantity = 1,
      accessToken = key.token,
    }) => {
      try {
        const orderData = {
          product: "I",
          validity: "DAY",
          price: 0,
          tag: "",
          order_type: "MARKET",
          transaction_type,
          disclosed_quantity: 0,
          trigger_price: 0,
          is_amo: false,
          quantity,
          instrument_token: instrument_key,
        };
        logInfo("Placing Upstox order (exitOpenTrades)", {
          brokerKeyId: key.id,
          transaction_type,
          quantity,
          instrument_key,
        });
        const response = await axios.post(
          "https://api.upstox.com/v2/order/place",
          orderData,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          },
        );
        logInfo("Order placed (exitOpenTrades)", {
          brokerKeyId: key.id,
          transaction_type,
          quantity,
          instrument_key,
          order_id: response?.data?.data?.order_id,
        });
        return response.data;
      } catch (err) {
        logError("Order error (exitOpenTrades)", err, {
          brokerKeyId: key.id,
          instrument_key,
          transaction_type,
          quantity,
        });
        // continue flow (still deactivate)
      }
    };

    const newOrder = async (data) => {
      data.transaction_type = "BUY";
      return await placeIntradayOrder(data);
    };
    const exitOrder = async (data) => {
      data.transaction_type = "SELL";
      return await placeIntradayOrder(data);
    };

    try {
      const lastTrade = await TradeLog.findDoc(
        { brokerKeyId: key.id, type: "entry" },
        { allowNull: true },
      );
      if (!lastTrade) {
        if (!key.status) continue;
        key.status = false;
        await key.save();
        logInfo("No last trade, marking key as inactive (closing time)", {
          brokerKeyId: key.id,
        });
        continue;
      }
      const exitOrderData = {
        instrument_key: lastTrade.asset,
        quantity: lastTrade.quantity,
      };
      logInfo("Exiting the last trade (closing time)", {
        brokerKeyId: key.id,
        asset: lastTrade.asset,
        qty: lastTrade.quantity,
      });
      await exitOrder(exitOrderData);
      lastTrade.type = "exit";
      await lastTrade.save();
      key.status = false;
      await key.save();
      logInfo("Key inactive after exiting last trade (closing time)", {
        brokerKeyId: key.id,
      });
    } catch (e) {
      logError("exitOpenTrades failed", e, { brokerKeyId: key?.id });
    }
  }
}

// Flags for two crons
let isRunning3Min = false;
let isRunning5Min = false;

// Shared trading logic
async function runTradingLogic({ intervalMinutes, intervalString }) {
  const istNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const istHour = istNow.getHours();
  const istMinute = istNow.getMinutes();
  const second = istNow.getSeconds();

  const preRange =
    (istHour === 8 && istMinute >= 30) ||
    (istHour > 8 && istHour < 15) ||
    (istHour === 15 && istMinute <= 30);
  const isInMarketRange =
    (istHour === 9 && istMinute >= 30) ||
    (istHour > 9 && istHour < 15) ||
    (istHour === 15 && istMinute <= 15);

  if (!preRange && !isInMarketRange) return;

  if (preRange) {
    if (!dailyLevels) {
      const [dailyData] = await sequelize.query(
        `SELECT * FROM "DailyLevels" WHERE "forDay" = '${getISTMidnightFakeUTCString()}'`,
      );
      dailyLevels = dailyData;
      logInfo("Loaded dailyLevels", { present: !!dailyLevels });
    }
    if (!dailyAsset) {
      const day = dayMap[istNow.getDay()];
      const [response] = await sequelize.query(
        `SELECT "name", "zerodhaToken","Assets"."id" FROM "DailyAssets"
         INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
         WHERE "day" = '${day}'`,
      );
      if (!response.length) {
        logWarn("❌ No asset available for today", { day });
        return;
      }
      dailyAsset = response;
      logInfo("Loaded dailyAsset", {
        name: dailyAsset?.name,
        token: dailyAsset?.zerodhaToken,
      });
    }
    if (!keys || !adminKeys || (istMinute % 1 === 0 && second % 40 === 0)) {
      const responseKeys = await BrokerKey.findAll({
        include: [{ model: Broker, where: { name: "Upstox" } }],
        where: { status: true },
      });
      const [admin] = await sequelize.query(
        `SELECT * FROM "BrokerKeys"
       INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
       INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
       WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'`,
      );
      adminKeys = admin;
      keys = responseKeys;
      logInfo("Refreshed keys/adminKeys", {
        keysCount: Array.isArray(keys) ? keys.length : 0,
        hasAdmin: !!adminKeys,
      });
    }
  }

  if (istHour === 15 && istMinute === 15) {
    logInfo("Hard exit time — exiting open trades");
    return await exitOpenTrades(keys || []);
  }

  if (isInMarketRange && second % 10 === 0) {
    const toTime = toKiteISTFormat(istNow);
    const fromTime = toKiteISTFormat(
      new Date(istNow.getTime() - intervalMinutes * 60 * 1000),
    );
    const instrumentToken = dailyAsset.zerodhaToken;
    const interval = intervalString;
    const apiKey = adminKeys.apiKey;
    const accessToken = adminKeys.token;

    const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(
      fromTime,
    )}&to=${encodeURIComponent(toTime)}&continuous=false`;

    let dataObj;
    try {
      const response = await axios.get(url, {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${apiKey}:${accessToken}`,
        },
      });
      dataObj = response?.data?.data;
    } catch (e) {
      logError("Historical data fetch failed", e, {
        instrumentToken,
        interval,
        fromTime,
        toTime,
      });
      return;
    }

    if (
      !dataObj ||
      !Array.isArray(dataObj.candles) ||
      dataObj.candles.length === 0
    ) {
      logWarn("⚠️ No candle data available", {
        instrumentToken,
        interval,
        fromTime,
        toTime,
      });
      return;
    }

    const latestCandle = dataObj.candles[dataObj.candles.length - 1];
    const price = latestCandle?.[12]; // close
    if (price === null || price === undefined) {
      logWarn("⚠️ Invalid Price", { latestCandle });
      return;
    }

    const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4 } = dailyLevels;
    const BUFFER = dailyLevels.buffer;

    let signal = "No Action";
    let reason = "Price is in a neutral zone.";
    let direction;
    let assetPrice;

    if (price % 100 > 50) {
      assetPrice = parseInt(price / 100) * 100 + 100;
    } else {
      assetPrice = parseInt(price / 100) * 100;
    }

    if (price >= tc && price <= tc + BUFFER) {
      direction = "CE";
      signal = "Buy";
      reason = "Price is above TC within buffer.";
    } else if (price <= bc && price >= bc - BUFFER) {
      direction = "PE";
      signal = "Sell";
      reason = "Price is below BC within buffer.";
    } else if (price < tc && price > bc) {
      signal = "Exit";
      reason = "Price is within CPR range.";
    }

    const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };
    Object.entries(levelsMap).forEach(([levelName, level]) => {
      if (price > level && price <= level + BUFFER) {
        signal = "Buy";
        reason = `Price is above ${levelName} (${level}) within buffer.`;
        direction = "CE";
      } else if (price < level && price >= level - BUFFER) {
        signal = "Sell";
        reason = `Price is below ${levelName} (${level}) within buffer.`;
        direction = "PE";
      }
    });

    const innerLevelMap = { r1, r2, r3, r4, s1, s2, s3, s4, tc, bc };
    const o = latestCandle?.[13];
    const c = latestCandle?.[12];
    Object.entries(innerLevelMap).find(([levelName, level]) => {
      if (signal === "No Action") {
        if (c > level && o < level) {
          signal = "PE Exit";
          reason = `Price crossed the level ${levelName}`;
          return true;
        }
        if (c < level && o > level) {
          signal = "CE Exit";
          reason = `Price crossed the level ${levelName}`;
          return true;
        }
      }
      return false;
    });

    if (direction === "CE") {
      assetPrice += 600;
    } else if (direction === "PE") {
      assetPrice -= 600;
    }

    let symbol;
    if (direction) {
      try {
        symbol = await findImmediateOption(
          dailyAsset.name,
          assetPrice,
          direction,
        );
      } catch (e) {
        logError("findImmediateOption failed", e, {
          base: dailyAsset?.name,
          assetPrice,
          direction,
          tf: intervalString,
        });
      }
    }

    logInfo("Signal snapshot", {
      t: istNow.toISOString(),
      price,
      direction,
      signal,
      reason,
      tf: intervalString,
    });

    for (const key of keys || []) {
      try {
        const getLTP = async (instrumentkey, accesstoken = key.token) => {
          try {
            const res = await axios.get(
              "https://api.upstox.com/v2/market-quote/ltp",
              {
                headers: {
                  Authorization: `Bearer ${accesstoken}`,
                  Accept: "application/json",
                },
                params: { instrument_key: instrumentkey },
              },
            );
            const ltp = Object.values(res?.data?.data || {})?.last_price;
            return ltp;
          } catch (err) {
            logError("❌ error fetching ltp", err, {
              instrumentkey,
              brokerKeyId: key.id,
            });
            throw err;
          }
        };

        const getTodaysPnL = async (accessToken = key.token) => {
          try {
            const response = await axios.get(
              "https://api.upstox.com/v2/portfolio/short-term-positions",
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              },
            );
            const positions = response?.data?.data || [];
            let totalRealised = 0;
            let totalUnrealised = 0;
            for (const pos of positions) {
              if (pos.product === "I") {
                totalRealised += Number(pos.realised || 0);
                totalUnrealised += Number(pos.unrealised || 0);
              }
            }
            const totalPnL = totalRealised + totalUnrealised;
            return totalPnL;
          } catch (error) {
            logError("❌ Failed to fetch today's intraday PnL", error, {
              brokerKeyId: key.id,
            });
            throw error;
          }
        };

        const balance = Number(key.balance);
        const usableFunds = (balance / 100) * 10;

        let ltp;
        let noOfLots;
        if (direction && symbol) {
          ltp = await getLTP(symbol.instrument_key);
          noOfLots = Math.floor(usableFunds / (ltp * symbol.lot_size));
        }

        const pnl = await getTodaysPnL();
        const maxLoss = (balance / 100) * 4;
        const maxProfit = (balance / 100) * 8;

        const placeIntradayOrder = async ({
          instrument_key,
          transaction_type = "BUY",
          quantity = 1,
          accessToken = key.token,
        }) => {
          try {
            const orderData = {
              product: "I",
              validity: "DAY",
              price: 0,
              tag: "",
              order_type: "MARKET",
              transaction_type,
              disclosed_quantity: 0,
              trigger_price: 0,
              is_amo: false,
              quantity,
              instrument_token: instrument_key,
            };
            logInfo("Placing Upstox order", {
              brokerKeyId: key.id,
              transaction_type,
              quantity,
              instrument_key,
              tf: intervalString,
            });
            const response = await axios.post(
              "https://api.upstox.com/v2/order/place",
              orderData,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
              },
            );
            logInfo("✅ Order placed", {
              brokerKeyId: key.id,
              transaction_type,
              quantity,
              instrument_key,
              tf: intervalString,
              order_id: response?.data?.data?.order_id,
            });
            return response.data;
          } catch (err) {
            logError("❌ Order error", err, {
              brokerKeyId: key.id,
              instrument_key,
              transaction_type,
              quantity,
              tf: intervalString,
            });
            throw err;
          }
        };

        const newOrder = async (data) => {
          data.transaction_type = "BUY";
          return await placeIntradayOrder(data);
        };
        const exitOrder = async (data) => {
          data.transaction_type = "SELL";
          return await placeIntradayOrder(data);
        };

        const lastTrade = await TradeLog.findDoc(
          { brokerKeyId: key.id, type: "entry" },
          { allowNull: true },
        );

        if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
          if (!lastTrade) {
            key.status = false;
            await key.save();
            logInfo(
              "No last trade, marking key as inactive (daily limit reached)",
              { brokerKeyId: key.id, pnl, balance },
            );
            continue;
          }
          const exitOrderData = {
            instrument_key: lastTrade.asset,
            quantity: lastTrade.quantity,
          };
          logInfo("Exiting last trade (daily limit reached)", {
            brokerKeyId: key.id,
            pnl,
            balance,
          });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();
          key.status = false;
          await key.save();
          logInfo("Key inactive after exiting last trade (daily limit)", {
            brokerKeyId: key.id,
          });
          continue;
        }

        // Strict guards for exact 3m/5m execution windows
        if (intervalMinutes === 3) {
          if (second >= 10) continue;
          if (istMinute % 3 !== 0) continue;
        } else if (intervalMinutes === 5) {
          if (second !== 0) continue;
          if (istMinute % 5 !== 0) continue;
        }

        if (signal === "No Action") continue;

        if (signal === "Exit" || signal === "PE Exit" || signal === "CE Exit") {
          if (!lastTrade) continue;
          const exitOrderData = {
            instrument_key: lastTrade.asset,
            quantity: lastTrade.quantity,
          };
          if (signal === "PE Exit" && lastTrade.direction === "PE") {
            logInfo("Signal PE EXIT matched, exiting trade", {
              brokerKeyId: key.id,
            });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          } else if (signal === "CE Exit" && lastTrade.direction === "CE") {
            logInfo("Signal CE EXIT matched, exiting trade", {
              brokerKeyId: key.id,
            });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
          if (signal === "Exit") {
            logInfo("Signal Exit, closing last trade", { brokerKeyId: key.id });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
        }

        if (lastTrade) {
          if (lastTrade.direction === direction) continue;
          const exitOrderData = {
            instrument_key: lastTrade.asset,
            quantity: lastTrade.quantity,
          };
          logInfo("Changing trade, exiting last trade", {
            brokerKeyId: key.id,
            from: lastTrade.direction,
            to: direction,
          });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();

          if (!symbol) continue;
          const newOrderData = {
            instrument_key: symbol.instrument_key,
            quantity: noOfLots * symbol.lot_size,
          };
          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: symbol.instrument_key,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };
          logInfo("Placing new trade after exiting last", {
            brokerKeyId: key.id,
            symbol: newTradeLog.asset,
          });
          await newOrder(newOrderData);
          await TradeLog.create(newTradeLog);
        } else {
          if (!symbol) continue;
          const newOrderData = {
            instrument_key: symbol.instrument_key,
            quantity: noOfLots * symbol.lot_size,
          };
          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: symbol.instrument_key,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };
          logInfo("Placing fresh trade", {
            brokerKeyId: key.id,
            symbol: newTradeLog.asset,
          });
          await newOrder(newOrderData);
          await TradeLog.create(newTradeLog);
        }
      } catch (e) {
        logError("Per-key execution failed", e, {
          brokerKeyId: key?.id,
          tf: intervalString,
        });
      }
    }
  }
}

// Schedule 3-minute interval cron
cron.schedule("* * * * * *", async () => {
  if (isRunning3Min) return;
  isRunning3Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 3, intervalString: "3minute" });
  } catch (e) {
    logError("3m cron failure", e);
  } finally {
    isRunning3Min = false;
  }
});

// Schedule 5-minute interval cron
cron.schedule("* * * * * *", async () => {
  if (isRunning5Min) return;
  isRunning5Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 5, intervalString: "5minute" });
  } catch (e) {
    logError("5m cron failure", e);
  } finally {
    isRunning5Min = false;
  }
});

server.post("/stop/:id?", async (req, res) => {
  try {
    const { id } = req.params;
    let targetKeys;
    targetKeys = id
      ? await BrokerKey.findDocById(id)
      : await BrokerKey.findAll({
          include: [
            {
              model: Broker,
              where: { name: "Upstox" },
            },
          ],
          where: { status: true },
        });
    const arr = Array.isArray(targetKeys)
      ? targetKeys
      : [targetKeys].filter(Boolean);
    if (arr.length) {
      await exitOpenTrades(arr);
      logInfo("Deactivated successfully via /stop", {
        count: arr.length,
        ids: arr.map((k) => k.id),
      });
    }
    res.status(200).json({ status: true, message: "Deactivated successfully" });
  } catch (e) {
    logError("Internal Server error on /stop", e);
    res.status(500).json({ status: false, message: "Internal Server error" });
  }
});

server.listen(3003, () => {
  logInfo("Upstox running on PORT 3003", { port: 3003 });
});
