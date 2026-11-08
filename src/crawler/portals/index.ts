import type { Portal } from '../../../db/schema';
import type { PortalAdapter } from '../types';
import { bezrealitkyAdapter } from './bezrealitky';
import { idnesAdapter } from './idnes';
import { srealityAdapter } from './sreality';

export const adapters: Record<Portal, PortalAdapter> = {
  sreality: srealityAdapter,
  bezrealitky: bezrealitkyAdapter,
  idnes: idnesAdapter,
};
