import fs from "fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import axios from "axios";
import zlib from "node:zlib";
import cron from "node-cron";

// --- Configuration ---
const INSTRUMENTS_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
const OUTPUT_DIR = "./downloads";
const OUTPUT_PATH = path.join(OUTPUT_DIR, "complete.json");

/**
 * Downloads the gzipped instruments file, extracts it, and saves it locally.
 * Returns a promise that resolves upon successful completion.
 * @returns {Promise<void>}
 */
export default async function downloadAndExtract() {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(
        `[${new Date().toLocaleString()}] Starting instruments file download...`,
      );

      const response = await axios.get(INSTRUMENTS_URL, {
        responseType: "stream",
      });

      // Ensure the output directory exists.
      await fs.mkdir(OUTPUT_DIR, { recursive: true });

      const gunzip = zlib.createGunzip();
      const writeStream = fsSync.createWriteStream(OUTPUT_PATH);

      // Set up a pipeline to download, decompress, and save the file.
      response.data.pipe(gunzip).pipe(writeStream);

      // Handle events to resolve or reject the promise.
      writeStream.on("finish", () => {
        console.log(
          `[${new Date().toLocaleString()}] File downloaded and extracted to ${OUTPUT_PATH}`,
        );
        resolve();
        findImmediateOption("NIFTY", 23300, "PE");
      });

      writeStream.on("error", (err) => {
        console.error("Error writing file:", err);
        reject(err);
      });

      gunzip.on("error", (err) => {
        console.error("Error decompressing file:", err);
        reject(err);
      });

      response.data.on("error", (err) => {
        console.error("Error during download:", err);
        reject(err);
      });
    } catch (error) {
      console.error("Download or extraction failed:", error.message);
      reject(error);
    }
  });
}

/**
 * Reads the local data file and finds the most immediate option.
 *
 * @param {string} assetSymbol - The asset symbol to search for (e.g., 'NIFTY').
 * @param {number} strikePrice - The target strike price.
 * @param {string} optionType - The type of option ('PE' for Put, 'CE' for Call).
 * @returns {Promise<Object|null>} A promise that resolves with the instrument or null if not found.
 */
async function findImmediateOption(assetSymbol, strikePrice, optionType) {
  try {
    // This function now reads the data file itself.
    const data = await fs.readFile(OUTPUT_PATH, "utf8");
    const instruments = JSON.parse(data);

    // Filter instruments based on user criteria (case-insensitive for symbols).
    const matchingInstruments = instruments.filter(
      (instrument) =>
        instrument.asset_symbol?.toUpperCase() === assetSymbol.toUpperCase() &&
        instrument.strike_price === strikePrice &&
        instrument.instrument_type?.toUpperCase() === optionType.toUpperCase(),
    );

    if (matchingInstruments.length === 0) {
      return null;
    }

    // Find the instrument with the earliest expiry date.
    const instrument = matchingInstruments.reduce((earliest, current) =>
      current.expiry < earliest.expiry ? current : earliest,
    );

    return console.log(instrument);
  } catch (err) {
    console.error(
      "Error reading or parsing instrument data inside findImmediateOption:",
      err,
    );
    // Throw the error to be caught by the calling function in main.
    throw err;
  }
}

/**
 * Main function to run the script.
 * It ensures the data file exists (downloads if not), then prompts for user input.
 */
async function main() {
  try {
    // 1. Caching: Check if the file exists. If not, download it.
    try {
      await fs.access(OUTPUT_PATH);
      console.log(`Using cached instruments file from: ${OUTPUT_PATH}`);
    } catch (error) {
      console.log(
        "Instruments file not found, downloading for the first time...",
      );
      await downloadAndExtract();
    }
  } catch (err) {
    // This will catch errors from the main logic or from findImmediateOption.
    if (err instanceof SyntaxError) {
      console.error(
        "Error: Failed to parse JSON. The file might be corrupted.",
      );
    } else {
      console.error("An unexpected error occurred:", err.message);
    }
  }
}

// --- Script Execution ---

// Run the main interactive function.
main();

// Schedule a cron job to update the instruments file every day at 7:00 AM.
cron.schedule("0 7 * * *", () => {
  console.log(
    `[${new Date().toLocaleString()}] Cron job: Starting daily instruments file update.`,
  );
  downloadAndExtract().catch((err) => {
    console.error(`[${new Date().toLocaleString()}] Daily update failed:`, err);
  });
});

console.log("Script initialized. Interactive prompt is active.");
console.log(
  "A background job is scheduled to update the data file daily at 7:00 AM.",
);
