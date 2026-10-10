/** UNRECOGNIZED_DOCUMENT: an uploaded file could not be classified, so nothing was taken from it. */
import type { Rule } from '../context';
import { makeIssue } from '../lib/issues';
import { truncate } from '../lib/text';

export const unrecognizedDocumentRule: Rule = {
  name: 'unrecognized-document',
  codes: ['UNRECOGNIZED_DOCUMENT'],
  run: (ctx) =>
    ctx.others.map(({ doc, data }) =>
      makeIssue({
        code: 'UNRECOGNIZED_DOCUMENT',
        key: doc.docId,
        severity: 'info',
        category: 'format',
        title: `Unrecognized document: ${doc.fileName}`,
        detail: `${doc.fileName}${data.title ? ` ("${truncate(data.title, 80)}")` : ''} is not a commercial invoice, packing list, bill of lading, air waybill or arrival notice (classification score ${Math.round((doc.classificationScore ?? 0) * 100)}%), so no data was taken from it.`,
        evidence: data.text ? [{ docId: doc.docId, page: 1, text: truncate(data.text, 200) }] : [],
        action: 'Review it manually (e.g. certificate of origin, fibre test report, credit note) and enter any relevant data yourself.',
      }),
    ),
};
