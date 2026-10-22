/**
 * The order book's cues (`state.ladderCues`, the Cues button in the book's header): what lights when a venue's displayed depth changes, and the
 * heat strip under each venue's part of a level. Kept apart from the pane so the store can read it without the pane's weight.
 *
 * `look`: Wash lights the cell and runs a crest through it; Rim leaves the cell alone and lights its outer edge; Deposit shows the layer an
 * addition made and the crest of a decrease; Marks lights nothing and keeps only the signed marks beside the rows; Off draws nothing at all.
 * `heat`: the strip under each cell, Added the share of the cell that is estimated recent net increase, Activity the recent change (adds
 * and removes) against the cell's size.
 */
export const CUE_LOOKS = ['off', 'wash', 'rim', 'deposit', 'marks'] as const;
export type CueLookSetting = (typeof CUE_LOOKS)[number];
export const HEAT_KINDS = ['off', 'added', 'activity'] as const;
export type HeatKind = (typeof HEAT_KINDS)[number];

export interface LadderCues { look: CueLookSetting; heat: HeatKind }

/** Everything on, as the page's new features are (the choice is one click away). A save that holds none gets these; an explicit Off is kept. */
export const LADDER_CUES_DEFAULT: LadderCues = { look: 'wash', heat: 'added' };

/** The settings of a save or a layout, field by field: anything missing or not one of the choices gets its default. */
export function readLadderCues(raw: unknown): LadderCues {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    look: (CUE_LOOKS as readonly unknown[]).includes(o.look) ? o.look as CueLookSetting : LADDER_CUES_DEFAULT.look,
    heat: (HEAT_KINDS as readonly unknown[]).includes(o.heat) ? o.heat as HeatKind : LADDER_CUES_DEFAULT.heat,
  };
}
