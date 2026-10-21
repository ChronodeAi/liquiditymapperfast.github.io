import { t } from '../i18n.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import { bandOf, type TofBand, type TofLevel } from './model.ts';

/** A band in words. */
export function bandText(band: TofBand | null): string {
  return band === 'toxic' ? t('toxic') : band === 'elevated' ? t('elevated') : band === 'normal' ? t('normal') : band === 'quiet' ? t('quiet') : t('not judged yet');
}

/** "$4.2M · 3.1× usual · z 2.4 toxic" for a reading, its usual and its z. */
export function readingText(tof: number | null, usual: number | null, z: number | null): string {
  if (tof === null) return t('nothing recorded');
  const parts = [`$${usd(tof)}`];
  if (usual !== null && usual > 0) parts.push(t('{times}× usual', { times: (tof / usual).toFixed(1) }));
  parts.push(z === null ? bandText(null) : `z ${z.toFixed(1)} ${bandText(bandOf(z))}`);
  return parts.join(' · ');
}

/** The box for a TOF level under the pointer: the candle that left it, its reading, and whether price has come back to it. */
export function tofLevelLines(level: TofLevel): InfoLine[] {
  return [
    { text: t('TOF level'), bold: true },
    { label: t('Price'), text: fmtPrice(level.price) },
    { label: t('Candle'), text: clock(level.t, true) },
    { label: t('Reading'), text: readingText(level.tof, null, level.z) },
    level.taken === null
      ? { text: t('Untapped: price has not traded back to it.'), rule: true }
      : { text: t('Taken at {time}: price traded back through it.', { time: clock(level.taken, true) }), color: 'muted', rule: true },
    { text: t('A candle\'s open stays a level until price comes back to it, so those still shown are where moves went on; the ones whose move failed were taken.'), color: 'muted', wrap: true },
  ];
}
