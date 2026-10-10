import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { BrokerInputs, Issue, PipelineResult } from '@app/shared';
import {
  BOND_TYPES,
  INPUT_CLEARS,
  ENTRY_TYPES,
  PAYMENT_TYPES,
  fromFormValues,
  issuesClearedBy,
  toFormValues,
  validateBrokerForm,
  type BrokerFormErrors,
  type BrokerFormField,
  type BrokerFormValues,
} from '../lib/broker-inputs';
import { severityLabel } from '../lib/format';

interface BrokerInputsTabProps {
  result: PipelineResult;
  brokerInputs: BrokerInputs;
  onSubmit(inputs: BrokerInputs): void;
  regenerating: boolean;
  lastRegeneratedAt: number | null;
}

type TextField = Exclude<BrokerFormField, 'autoApplyRemedies'>;

interface FieldSpec {
  name: TextField;
  label: string;
  hint?: string;
  type?: 'text' | 'date' | 'select';
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'text';
}

const GROUPS: { legend: string; fields: FieldSpec[] }[] = [
  {
    legend: 'Importer',
    fields: [
      {
        name: 'importerTaxId',
        label: 'Importer tax ID',
        hint: 'EIN NN-NNNNNNN (+ optional 2-character suffix), CBP-assigned YYDDPP-NNNNN, or SSN NNN-NN-NNNN.',
        placeholder: '12-3456789',
        maxLength: 13,
      },
      { name: 'importerName', label: 'Importer name', hint: 'Overrides the name read from the documents.' },
      { name: 'ultimateConsigneeTaxId', label: 'Ultimate consignee tax ID', hint: 'Same formats as the importer tax ID.', maxLength: 13 },
    ],
  },
  {
    legend: 'Bond and payment',
    fields: [
      { name: 'bondType', label: 'Bond type', type: 'select', options: BOND_TYPES },
      { name: 'suretyCode', label: 'Surety code', hint: '3 characters, from the bond.', placeholder: '036', maxLength: 3 },
      { name: 'paymentType', label: 'Payment type', type: 'select', options: PAYMENT_TYPES },
    ],
  },
  {
    legend: 'Entry',
    fields: [
      { name: 'entryType', label: 'Entry type', type: 'select', options: ENTRY_TYPES },
      { name: 'entryPort', label: 'Entry port override', hint: '4-digit Schedule D code. Leave empty to use the port from the documents.', maxLength: 4, inputMode: 'numeric' },
      { name: 'locationOfGoods', label: 'Location of goods (FIRMS)', hint: 'Up to 4 characters.', maxLength: 4 },
      { name: 'entryDate', label: 'Entry date', type: 'date', hint: 'Defaults to the arrival date.' },
      { name: 'arrivalDate', label: 'Arrival date', type: 'date', hint: 'Overrides the estimated arrival (ETA).' },
      { name: 'brokerReference', label: 'Broker reference', maxLength: 35 },
    ],
  },
];

/** Fields in on-screen order, so focus goes to the first invalid field the user sees. */
const FORM_ORDER: BrokerFormField[] = [...GROUPS.flatMap((g) => g.fields.map((f) => f.name)), 'autoApplyRemedies'];

function ClearsNote({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <span className="clears">
      {issues.map((issue) => (
        <span key={issue.id} className={`clears-item clears-${issue.severity}`}>
          Clears {severityLabel(issue.severity).toLowerCase()}: {issue.title}
        </span>
      ))}
    </span>
  );
}

/** Form for everything only the broker knows (IOR number, bond, surety, FIRMS…); submitting regenerates the entry. */
export function BrokerInputsTab({ result, brokerInputs, onSubmit, regenerating, lastRegeneratedAt }: BrokerInputsTabProps) {
  const formId = useId();
  const [values, setValues] = useState<BrokerFormValues>(() => toFormValues(brokerInputs));
  const [errors, setErrors] = useState<BrokerFormErrors>({});
  const fieldId = (name: BrokerFormField) => `${formId}-${name}`;

  const placeholders: Partial<Record<TextField, string>> = {
    importerName: result.entryModel.header.importerName,
    entryPort: result.entryModel.header.entryPort,
  };

  const set = (name: BrokerFormField, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateBrokerForm(values);
    setErrors(found);
    const firstInvalid = FORM_ORDER.find((name) => found[name]);
    if (firstInvalid) {
      document.getElementById(fieldId(firstInvalid))?.focus();
      return;
    }
    onSubmit(fromFormValues(values, brokerInputs.decisions));
  };

  const clearable = GROUPS.flatMap((g) => g.fields).flatMap((f) => issuesClearedBy(f.name, result.issues));
  const clearableBlockers = clearable.filter((i) => i.severity === 'blocker');

  const renderControl = (spec: FieldSpec, describedBy: string): ReactNode => {
    const common = {
      id: fieldId(spec.name),
      name: spec.name,
      'aria-invalid': errors[spec.name] ? true : undefined,
      'aria-describedby': describedBy || undefined,
    };
    if (spec.type === 'select') {
      const options = spec.options ?? [];
      const current = values[spec.name];
      const known = options.some((o) => o.value === current);
      return (
        <select {...common} value={current} onChange={(e) => set(spec.name, e.target.value)}>
          {spec.name !== 'entryType' && <option value="">Not set</option>}
          {!known && current !== '' && <option value={current}>{current}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        {...common}
        type={spec.type === 'date' ? 'date' : 'text'}
        value={values[spec.name]}
        placeholder={spec.placeholder ?? placeholders[spec.name]}
        maxLength={spec.maxLength}
        inputMode={spec.inputMode}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set(spec.name, e.target.value)}
      />
    );
  };

  return (
    <form className="broker-form" onSubmit={submit} noValidate aria-describedby={`${formId}-intro`}>
      <div className="tab-intro" id={`${formId}-intro`}>
        <p>
          Information the documents cannot provide. Values are validated against the NetCHB schema patterns; submitting regenerates the XML without
          re-reading the documents.
          {clearableBlockers.length > 0 && (
            <>
              {' '}
              <strong>
                {clearableBlockers.length} open blocker{clearableBlockers.length === 1 ? '' : 's'} can be cleared here.
              </strong>
            </>
          )}
        </p>
      </div>

      {GROUPS.map((group) => (
        <fieldset key={group.legend} className="form-group">
          <legend>{group.legend}</legend>
          <div className="form-grid">
            {group.fields.map((spec) => {
              const hintId = spec.hint ? `${fieldId(spec.name)}-hint` : '';
              const errorId = errors[spec.name] ? `${fieldId(spec.name)}-error` : '';
              const clears = issuesClearedBy(spec.name, result.issues);
              const clearsId = clears.length ? `${fieldId(spec.name)}-clears` : '';
              return (
                <div key={spec.name} className={`form-field${errors[spec.name] ? ' has-error' : ''}`}>
                  <label htmlFor={fieldId(spec.name)}>{spec.label}</label>
                  {renderControl(spec, [errorId, hintId, clearsId].filter(Boolean).join(' '))}
                  {errors[spec.name] && (
                    <span id={errorId} className="field-error">
                      {errors[spec.name]}
                    </span>
                  )}
                  {spec.hint && (
                    <span id={hintId} className="field-hint">
                      {spec.hint}
                    </span>
                  )}
                  {clears.length > 0 && (
                    <span id={clearsId}>
                      <ClearsNote issues={clears} />
                    </span>
                  )}
                  {clears.length === 0 && INPUT_CLEARS[spec.name] && brokerInputs[spec.name] && (
                    <span className="clears-item clears-done">✓ Resolved by this input</span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      <fieldset className="form-group">
        <legend>Options</legend>
        <div className="checkbox-row">
          <input
            id={fieldId('autoApplyRemedies')}
            type="checkbox"
            checked={values.autoApplyRemedies}
            onChange={(e) => set('autoApplyRemedies', e.target.checked)}
            aria-describedby={`${fieldId('autoApplyRemedies')}-hint`}
          />
          <label htmlFor={fieldId('autoApplyRemedies')}>Auto-apply trade remedies in NetCHB</label>
        </div>
        <span id={`${fieldId('autoApplyRemedies')}-hint`} className="field-hint">
          Lets NetCHB add Chapter 99 remedies for single-tariff lines. This app does not compute them.
        </span>
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={regenerating}>
          {regenerating ? 'Regenerating…' : 'Regenerate entry'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setValues(toFormValues(brokerInputs));
            setErrors({});
          }}
          disabled={regenerating}
        >
          Reset
        </button>
        <span className="muted" role="status">
          {regenerating ? 'Regenerating entry…' : lastRegeneratedAt ? `Entry regenerated at ${new Date(lastRegeneratedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>
    </form>
  );
}
