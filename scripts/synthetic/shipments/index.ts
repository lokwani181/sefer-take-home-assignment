/** Registry of all synthetic shipments, in generation order. */
import type { ShipmentSpec } from '../spec.js';
import { s1 } from './s1-air-eur-fca.js';
import { s2 } from './s2-scan-cn-ddp.js';
import { s3 } from './s3-messy-minimal.js';
import { s4 } from './s4-kr-fob-multi-container.js';
import { s5 } from './s5-id-footwear-cfr.js';

export const SHIPMENTS: ShipmentSpec[] = [s1, s2, s3, s4, s5];
