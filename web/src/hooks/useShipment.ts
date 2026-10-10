import { useCallback, useRef, useState } from 'react';
import type { ApiError, BrokerInputs, PipelineResult } from '@app/shared';
import type { ApiClient } from '../api/client';
import { toApiError } from '../api/client';
import { decisionDefaults, inputsFromResult } from '../lib/broker-inputs';

export interface ShipmentController {
  result: PipelineResult | null;
  /** Increments on every successful upload; use as a React key to reset per-shipment UI state. */
  generation: number;
  /** Mirrors result.brokerInputs with every decision filled in; updated optimistically on regenerate. */
  brokerInputs: BrokerInputs;
  /** Decisions as first proposed by the app for this shipment (the policy defaults). */
  recommendedDecisions: Record<string, string>;
  uploadStartedAt: number | null;
  uploadError: ApiError | null;
  regenerating: boolean;
  regenerateError: ApiError | null;
  lastRegeneratedAt: number | null;
  upload(files: File[]): Promise<void>;
  regenerate(inputs: BrokerInputs): Promise<void>;
  changeDecision(key: string, value: string): Promise<void>;
  clearUploadError(): void;
  clearRegenerateError(): void;
}

/**
 * Owns the shipment lifecycle: upload → result → regenerate with new inputs/decisions.
 * Each request gets a sequence number so a slow, stale response can never overwrite a newer one.
 */
export function useShipment(client: ApiClient): ShipmentController {
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [brokerInputs, setBrokerInputs] = useState<BrokerInputs>({});
  const [recommendedDecisions, setRecommendedDecisions] = useState<Record<string, string>>({});
  const [uploadStartedAt, setUploadStartedAt] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<ApiError | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<ApiError | null>(null);
  const [lastRegeneratedAt, setLastRegeneratedAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  const seq = useRef(0);
  const resultRef = useRef<PipelineResult | null>(null);
  const inputsRef = useRef<BrokerInputs>({});

  const applyResult = useCallback((next: PipelineResult) => {
    resultRef.current = next;
    const inputs = inputsFromResult(next);
    inputsRef.current = inputs;
    setResult(next);
    setBrokerInputs(inputs);
  }, []);

  const upload = useCallback(
    async (files: File[]) => {
      const mine = ++seq.current;
      setUploadStartedAt(Date.now());
      setUploadError(null);
      setRegenerateError(null);
      setRegenerating(false);
      try {
        const next = await client.createShipment(files);
        if (mine !== seq.current) return;
        applyResult(next);
        setRecommendedDecisions(decisionDefaults(next.issues));
        setLastRegeneratedAt(null);
        setGeneration((g) => g + 1);
      } catch (err) {
        if (mine === seq.current) setUploadError(toApiError(err));
      } finally {
        if (mine === seq.current) setUploadStartedAt(null);
      }
    },
    [client, applyResult],
  );

  const regenerate = useCallback(
    async (inputs: BrokerInputs) => {
      const current = resultRef.current;
      if (!current) return;
      const mine = ++seq.current;
      inputsRef.current = inputs;
      setBrokerInputs(inputs);
      setRegenerating(true);
      setRegenerateError(null);
      try {
        const next = await client.regenerate(current.shipmentId, inputs);
        if (mine !== seq.current) return;
        applyResult(next);
        setLastRegeneratedAt(Date.now());
      } catch (err) {
        if (mine !== seq.current) return;
        setRegenerateError(toApiError(err));
        // Roll the optimistic inputs back to what the visible result was built from.
        const visible = resultRef.current;
        if (visible) {
          inputsRef.current = inputsFromResult(visible);
          setBrokerInputs(inputsRef.current);
        }
      } finally {
        if (mine === seq.current) setRegenerating(false);
      }
    },
    [client, applyResult],
  );

  const changeDecision = useCallback(
    (key: string, value: string) => {
      const latest = inputsRef.current;
      return regenerate({ ...latest, decisions: { ...(latest.decisions ?? {}), [key]: value } });
    },
    [regenerate],
  );

  return {
    result,
    generation,
    brokerInputs,
    recommendedDecisions,
    uploadStartedAt,
    uploadError,
    regenerating,
    regenerateError,
    lastRegeneratedAt,
    upload,
    regenerate,
    changeDecision,
    clearUploadError: useCallback(() => setUploadError(null), []),
    clearRegenerateError: useCallback(() => setRegenerateError(null), []),
  };
}
