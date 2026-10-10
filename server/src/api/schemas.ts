/**
 * Request validation for the API (and the CLI's --inputs file).
 * Only shapes and types are checked here: format rules (EIN, bond enum, FIRMS length …) are
 * checked during assembly, where an invalid value becomes a blocker issue the broker can fix
 * instead of a rejected request.
 */
import { z } from 'zod';
import type { BrokerInputs } from '@app/shared';

const optionalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .optional();

export const brokerInputsSchema = z
  .object({
    importerTaxId: optionalString,
    importerName: optionalString,
    ultimateConsigneeTaxId: optionalString,
    bondType: optionalString,
    suretyCode: optionalString,
    paymentType: optionalString,
    entryType: optionalString,
    entryPort: optionalString,
    locationOfGoods: optionalString,
    entryDate: optionalString,
    arrivalDate: optionalString,
    autoApplyRemedies: z.boolean().optional(),
    brokerReference: optionalString,
    exchangeRates: z.record(z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 currency code'), z.number().positive().finite()).optional(),
    decisions: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict()
  .transform((v) => {
    // Empty strings from a form mean "not set".
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== '') out[k] = val;
    if (out.exchangeRates) {
      out.exchangeRates = Object.fromEntries(Object.entries(out.exchangeRates as Record<string, number>).map(([c, r]) => [c.toUpperCase(), r]));
    }
    return out as BrokerInputs;
  });

export const regenerateBodySchema = z
  .object({
    brokerInputs: brokerInputsSchema.optional(),
    /** Accepted for convenience (PLAN §2): merged into brokerInputs.decisions. */
    decisions: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

// Compile-time guard: every BrokerInputs field must be accepted by the schema (strict() rejects unknown keys).
type MissingKeys = Exclude<keyof BrokerInputs, keyof z.input<typeof brokerInputsSchema>>;
export const BROKER_INPUT_KEYS_COVERED: [MissingKeys] extends [never] ? true : MissingKeys = true;

/** Readable one-line summary of zod issues. */
export function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
