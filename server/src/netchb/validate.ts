/**
 * XSD validation of generated entry XML against the vendored NetCHB schemas.
 *
 * Primary path: xmllint-wasm (no system dependency). entry.xsd imports
 * data_type.xsd by the relative schemaLocation "data_type.xsd", so that file is
 * preloaded into the wasm file system under exactly that name. If the wasm
 * worker cannot run, falls back to the system `xmllint --noout --schema`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidateXmlFn, XsdValidation } from '@app/shared';
import { validateXML } from 'xmllint-wasm';

const SCHEMA_DIR = fileURLToPath(new URL('./schema/', import.meta.url));
const ENTRY_XSD = 'entry.xsd';
const DATA_XSD = 'data_type.xsd';
const XML_NAME = 'entry.xml';

let schemaCache: Promise<{ entry: string; data: string }> | undefined;

function loadSchemas(): Promise<{ entry: string; data: string }> {
  schemaCache ??= Promise.all([
    readFile(join(SCHEMA_DIR, ENTRY_XSD), 'utf8'),
    readFile(join(SCHEMA_DIR, DATA_XSD), 'utf8'),
  ]).then(([entry, data]) => ({ entry, data }));
  return schemaCache;
}

/** Turns "entry.xml:31: Schemas validity error : Element ..." into "Line 31: Element ...". */
export function formatXmllintMessage(raw: string): string | undefined {
  const line = raw.trim();
  if (!line || /^\^+$/.test(line) || / validates$/.test(line) || /fails to validate$/.test(line)) return undefined;
  const m = /^(?:[^:]*?):(\d+):\s*(?:(?:Schemas validity|parser|namespace) (?:error|warning)\s*:\s*)?(.*)$/.exec(line);
  if (m) return `Line ${m[1]}: ${m[2].trim()}`;
  return line;
}

function dedupe(errors: (string | undefined)[]): string[] {
  return [...new Set(errors.filter((e): e is string => !!e))];
}

async function validateWithWasm(xml: string): Promise<XsdValidation> {
  const { entry, data } = await loadSchemas();
  const result = await validateXML({
    xml: { fileName: XML_NAME, contents: xml },
    schema: { fileName: ENTRY_XSD, contents: entry },
    preload: [{ fileName: DATA_XSD, contents: data }],
  });
  if (result.valid) return { valid: true, errors: [] };
  const errors = dedupe(result.errors.map((e) => formatXmllintMessage(e.rawMessage)));
  return { valid: false, errors: errors.length ? errors : ['XSD validation failed (no message from xmllint)'] };
}

function validateWithSystemXmllint(xml: string): Promise<XsdValidation> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'netchb-xsd-'));
    try {
      const xmlPath = join(dir, XML_NAME);
      await writeFile(xmlPath, xml, 'utf8');
      return await new Promise<XsdValidation>((resolve, reject) => {
        execFile(
          'xmllint',
          ['--noout', '--schema', join(SCHEMA_DIR, ENTRY_XSD), xmlPath],
          { timeout: 30_000 },
          (err, _stdout, stderr) => {
            if (!err) return resolve({ valid: true, errors: [] });
            const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
            if (code === 'ENOENT') return reject(new Error('xmllint is not installed'));
            const errors = dedupe(String(stderr).split('\n').map(formatXmllintMessage));
            resolve({ valid: false, errors: errors.length ? errors : [String(err.message)] });
          },
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

/**
 * Validates entry XML against entry.xsd (+ data_type.xsd). Errors carry the XML
 * line number ("Line 12: ..."). Never throws: if no validator can run, returns
 * valid=false with an explanatory error so the UI never shows a false "valid".
 */
export const validateEntryXml: ValidateXmlFn = async (xml: string): Promise<XsdValidation> => {
  let wasmError: unknown;
  try {
    return await validateWithWasm(xml);
  } catch (e) {
    wasmError = e;
  }
  try {
    return await validateWithSystemXmllint(xml);
  } catch (e) {
    return {
      valid: false,
      errors: [
        `XSD validator unavailable (xmllint-wasm: ${errorMessage(wasmError)}; system xmllint: ${errorMessage(e)})`,
      ],
    };
  }
};

/** Exposed for tests: forces the system-xmllint fallback path. */
export const validateEntryXmlWithSystemXmllint = validateWithSystemXmllint;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
