import { APP_ID, DEFAULT_RECORD } from "./constants.js";
import {
  mergeImportedRecords,
  normalizeEnvelope,
  normalizeRecord,
  normalizeSortPreferences,
  validateImportEnvelope
} from "./models.js";

export function createStorage(gm, login) {
  const storageKey = `${APP_ID}:${login}`;
  const listeners = new Set();

  async function load() {
    const raw = await Promise.resolve(gm.getValue(storageKey, null));
    return normalizeEnvelope(raw, login);
  }

  async function save(envelope) {
    await Promise.resolve(gm.setValue(storageKey, envelope));
    return envelope;
  }

  function subscribe(onChange) {
    listeners.add(onChange);
    const listenerId = gm.addValueChangeListener
      ? gm.addValueChangeListener(storageKey, (_name, _oldValue, newValue, remote) => {
          if (!remote) {
            return;
          }
          onChange(normalizeEnvelope(newValue, login));
        })
      : null;

    return () => {
      listeners.delete(onChange);
      if (listenerId !== null && gm.removeValueChangeListener) {
        gm.removeValueChangeListener(listenerId);
      }
    };
  }

  async function upsertRecord(key, patch, timestamp) {
    const envelope = await load();
    const current = envelope.records[key] || DEFAULT_RECORD;
    envelope.records[key] = normalizeRecord({ ...current, ...patch, modifiedAt: timestamp });
    await save(envelope);
    for (const listener of listeners) {
      listener(envelope);
    }
    return envelope;
  }

  async function updateSortPreferences(sortPreferences) {
    const envelope = await load();
    envelope.sortPreferences = normalizeSortPreferences({
      ...envelope.sortPreferences,
      ...sortPreferences
    });
    await save(envelope);
    for (const listener of listeners) {
      listener(envelope);
    }
    return envelope;
  }

  async function importEnvelope(rawEnvelope) {
    validateImportEnvelope(rawEnvelope);
    if (rawEnvelope.accountLogin !== login) {
      throw new Error(`Import account ${rawEnvelope.accountLogin} does not match signed-in account ${login}.`);
    }
    const current = await load();
    const merged = normalizeEnvelope(current, login);
    merged.records = mergeImportedRecords(merged.records, rawEnvelope.records);
    await save(merged);
    for (const listener of listeners) {
      listener(merged);
    }
    return merged;
  }

  return {
    storageKey,
    load,
    save,
    subscribe,
    upsertRecord,
    updateSortPreferences,
    importEnvelope
  };
}
