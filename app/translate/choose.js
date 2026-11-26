// SPDX-License-Identifier: GPL-3.0-or-later
import { MissingModelsError } from './models.js';

/**
 * Makes `main` the language of a book. Tradotto without its models offers them instead, and changes nothing.
 * @param {{setMain: (main: string) => Promise<void>}} translation
 * @param {'original'|'translated'} main
 * @param {{offerModels: (missing: string[]) => void}} handlers
 * @returns {Promise<boolean>} Whether the book now reads in `main`.
 */
export async function chooseMain(translation, main, { offerModels }) {
  try {
    await translation.setMain(main);
    return true;
  } catch (error) {
    if (!(error instanceof MissingModelsError)) throw error;
    offerModels(error.missing);
    return false;
  }
}
