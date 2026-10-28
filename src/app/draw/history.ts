import { MAX_UNDO, type Drawing } from './model.ts';

/**
 * Undo and Redo for one coin's drawings (pure, tests/draw-model.test.mts): each step is the list before a change and after it, one step a
 * finished gesture (a drawing placed, dragged, restyled, deleted, a file read in), at most `MAX_UNDO` back. A coin keeps its own steps, so
 * Undo on another coin never takes back what was done on this one.
 */
export interface Step { before: readonly Drawing[]; after: readonly Drawing[] }

export class History {
  #undo: Step[] = [];
  #redo: Step[] = [];

  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }

  /** A change was made: it can be taken back, and what was taken back before can no longer be done again. */
  push(before: readonly Drawing[], after: readonly Drawing[]): void {
    if (before === after) return;
    this.#undo.push({ before, after });
    if (this.#undo.length > MAX_UNDO) this.#undo.shift();
    this.#redo = [];
  }

  /** The list to go back to, or null. */
  undo(): readonly Drawing[] | null {
    const step = this.#undo.pop(); if (!step) return null;
    this.#redo.push(step);
    return step.before;
  }

  /** The list to go forward to again, or null. */
  redo(): readonly Drawing[] | null {
    const step = this.#redo.pop(); if (!step) return null;
    this.#undo.push(step);
    return step.after;
  }
}
