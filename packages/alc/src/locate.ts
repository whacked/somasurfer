/**
 * Where templates enter. `locate` turns an address into millimetres in a named
 * template; `encode` turns millimetres in a named template into an address.
 *
 * The asymmetry worth noticing: an address has meaning without any template.
 * It denotes a cell in a dimensionless frame. A template is only needed to ask
 * "where is that in this particular body", and different templates — adult
 * male, 7-year-old, a population-specific average — answer differently for the
 * same address. That is the intended behaviour, not a bug.
 */

import { AlcError } from './codec.ts';
import { parse } from './address.ts';
import {
  bodyCellBox,
  bodyEncodeLocal,
  bodyLocate,
  bodyMmToLocal,
  parseBodyAnchors,
  type BodyTemplate,
} from './frames/bodySpine.ts';
import {
  bvCellBox,
  bvEncodeLocal,
  bvLocate,
  bvMmToLocal,
  type BrainVolumeTemplate,
} from './frames/brainVolume.ts';
import type { Hemisphere, Located } from './types.ts';

export interface TemplateSet {
  body?: BodyTemplate;
  brainVolume?: BrainVolumeTemplate;
}

export function locate(input: string, templates: TemplateSet): Located {
  const a = parse(input);
  switch (a.frame) {
    case 'BD': {
      if (!templates.body) throw new AlcError('no body template supplied', 'no_template');
      const anchors = parseBodyAnchors(a.anchors);
      return bodyLocate(templates.body, bodyCellBox(anchors, a.digits), a.digits.length);
    }
    case 'BV': {
      if (!templates.brainVolume) throw new AlcError('no brain volume template supplied', 'no_template');
      return bvLocate(templates.brainVolume, bvCellBox(a.anchors[0] as Hemisphere, a.digits), a.digits.length);
    }
    case 'BR':
      throw new AlcError(
        'frame BR is experimental in v1 and has no locatable template yet',
        'frame_disabled',
      );
    default:
      throw new AlcError(`frame ${a.frame} cannot be located`, 'unknown_frame');
  }
}

export function encodeBody(
  template: BodyTemplate,
  pointMm: readonly [number, number, number],
  digitCount: number,
): { address: string; flags: ReturnType<typeof bodyMmToLocal>['flags'] } {
  const { local, flags } = bodyMmToLocal(template, pointMm);
  const { anchors, digits } = bodyEncodeLocal(local, digitCount);
  const address = digits ? `BD-${anchors[0]}-${anchors[1]}-${digits}` : `BD-${anchors[0]}-${anchors[1]}`;
  return { address: parse(address).canonical, flags };
}

export function encodeBrainVolume(
  template: BrainVolumeTemplate,
  pointMm: readonly [number, number, number],
  digitCount: number,
): { address: string; flags: ReturnType<typeof bvMmToLocal>['flags'] } {
  const { hemisphere, local, flags } = bvMmToLocal(template, pointMm);
  const digits = bvEncodeLocal(hemisphere, local, digitCount);
  const address = digits ? `BV-${hemisphere}-${digits}` : `BV-${hemisphere}`;
  return { address: parse(address).canonical, flags };
}
