/**
 * The rating standard. An outcome is a measurement, not a compliment: the
 * bands say what each range of a 0-1 rating means, so the same work lands
 * in the same place whoever rates it.
 *
 * The failure this exists to fix is drift: when nearly every rating comes
 * back 0.8+, the matcher is told every model is excellent, the evidence
 * stops separating them, and the draw stops improving. A member that did
 * the task competently and nothing more is around 0.5.
 */

export interface RatingBand {
	/**
	 * Exclusive upper bound. The last band uses 1.01 as a sentinel so an
	 * outcome of exactly 1 is included; `bandRange` renders it as "1".
	 */
	below: number;
	/** Short name, used in the rating acknowledgement and the docs. */
	name: string;
	/** What the band means, as the rating guidance states it. */
	criterion: string;
}

export const RATING_BANDS: readonly RatingBand[] = [
	{
		below: 0.4,
		name: "less than competent",
		criterion:
			"did something wrong: failed the task, ignored a stated boundary, broke something, or needed repeated correction",
	},
	{
		below: 0.6,
		name: "satisfactory",
		criterion: "completed the task to the letter",
	},
	{
		below: 0.8,
		name: "beyond the task",
		criterion:
			"demonstrated work and understanding beyond the task itself; took care of adjacent issues",
	},
	{
		below: 1.01,
		name: "outstanding",
		criterion:
			"contributed greatly: the implementation would be significantly worse without its unique, non-obvious contribution",
	},
];

/** The band a 0-1 outcome falls in (clamped; band edges belong to the higher band). */
export function outcomeBand(outcome: number): RatingBand {
	const clamped = Math.max(0, Math.min(1, outcome));
	return RATING_BANDS.find((band) => clamped < band.below) ?? RATING_BANDS[RATING_BANDS.length - 1];
}

/**
 * The band's range, half-open like the docs: "below 0.4", "[0.4, 0.6)",
 * "[0.8, 1]".
 */
export function bandRange(index: number): string {
	const band = RATING_BANDS[index];
	const upper = band.below > 1 ? "1" : String(band.below);
	if (index === 0) return `below ${upper}`;
	const lower = RATING_BANDS[index - 1].below;
	return `[${lower}, ${upper}${band.below > 1 ? "]" : ")"}`;
}

/**
 * Why this rating cannot be recorded, or undefined if it can. A rating in
 * the "outstanding" band claims a specific contribution; without a note
 * saying what it was, it is an opinion the evidence cannot use.
 */
export function ratingProblem(outcome: number, note?: string): string | undefined {
	if (!Number.isFinite(outcome)) return "outcome is not a number between 0 and 1 — nothing was recorded";
	const clamped = Math.max(0, Math.min(1, outcome));
	if (clamped < 0.8) return undefined;
	if (note?.trim()) return undefined;
	return (
		`${clamped} is the "${outcomeBand(clamped).name}" band — that high means the work would be significantly ` +
		"worse without it, so say what it did in `note` (a competent run that did only what it was told is around " +
		"0.5, and most ratings should land there)"
	);
}
