// SPDX-License-Identifier: GPL-3.0-or-later

/** @typedef {{id: number, path: string}} Tab */

// Windows paths: two spellings that differ only by case are the same file.
const samePathKey = (path) => path.toLowerCase();

/** The open tabs, in bar order, and which one is active. Knows nothing about the DOM. */
export class Tabs {
  /** @type {Tab[]} */
  #tabs = [];
  #activeId = null;
  #nextId = 1;

  /**
   * Activates the tab of `path`, creating it if the file is not open yet.
   * @param {string} path
   * @returns {{id: number, created: boolean}}
   */
  open(path) {
    const key = samePathKey(path);
    const existing = this.#tabs.find((tab) => samePathKey(tab.path) === key);
    if (existing) {
      this.#activeId = existing.id;
      return { id: existing.id, created: false };
    }
    const id = this.#nextId++;
    this.#tabs.push({ id, path });
    this.#activeId = id;
    return { id, created: true };
  }

  /** @param {number} id An unknown id changes nothing. */
  activate(id) {
    if (this.#tabs.some((tab) => tab.id === id)) this.#activeId = id;
  }

  /**
   * Closing the active tab activates the one that takes its place, or the previous one if it was the last.
   * @param {number} id An unknown id changes nothing.
   */
  close(id) {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    this.#tabs.splice(index, 1);
    if (id !== this.#activeId) return;
    const neighbour = this.#tabs[index] ?? this.#tabs[index - 1];
    this.#activeId = neighbour ? neighbour.id : null;
  }

  /**
   * Activates the following tab, wrapping after the last one.
   * @returns {Tab|null} The tab now active.
   */
  next() {
    if (this.#tabs.length === 0) return null;
    const index = this.#tabs.findIndex((tab) => tab.id === this.#activeId);
    this.#activeId = this.#tabs[(index + 1) % this.#tabs.length].id;
    return this.active();
  }

  /** @returns {Tab[]} */
  all() {
    return [...this.#tabs];
  }

  /** @returns {Tab|null} */
  active() {
    return this.#tabs.find((tab) => tab.id === this.#activeId) ?? null;
  }
}
