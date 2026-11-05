import type { Core } from '@strapi/strapi';
import { DiscoveredSchema, discoverSchema, SYSTEM_ATTRIBUTES } from './schema-discovery';

export interface IntegrityDiff {
  path: string;
  expected: any;
  actual: any;
  message: string;
}

export interface IntegrityVerificationReport {
  documentId: string;
  title: string;
  status: 'SUCCESS' | 'WARNING' | 'FAILED';
  scalarFields: 'Verified' | 'Mismatch';
  components: 'Verified' | 'Mismatch' | 'N/A';
  dynamicZones: 'Verified' | 'Mismatch' | 'N/A';
  relations: 'Verified' | 'Mismatch' | 'N/A';
  media: 'Verified' | 'Mismatch' | 'N/A';
  missingDataCount: number;
  invalidRelationsCount: number;
  missingMediaCount: number;
  structuralDifferencesCount: number;
  diffs: IntegrityDiff[];
}

/**
 * Normalizes values for comparison, ignoring Strapi internal timestamps and system metadata
 */
function normalizeVal(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return val;

  if (Array.isArray(val)) {
    return val.map(normalizeVal);
  }

  if (typeof val === 'object') {
    const copy: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (SYSTEM_ATTRIBUTES.has(k.toLowerCase().replace(/[\s_-]/g, ''))) continue;
      copy[k] = normalizeVal(v);
    }
    return copy;
  }

  return val;
}

/**
 * Deep structural comparison between expected payload and saved document
 */
export function verifyDocumentIntegrity(
  strapi: Core.Strapi,
  uid: string,
  originalDoc: any,
  appliedPayload: Record<string, any>,
  savedDoc: any
): IntegrityVerificationReport {
  const schema = discoverSchema(strapi, uid);
  const diffs: IntegrityDiff[] = [];

  let scalarOk = true;
  let componentsOk = true;
  let dynamicZonesOk = true;
  let relationsOk = true;
  let mediaOk = true;

  let missingDataCount = 0;
  let invalidRelationsCount = 0;
  let missingMediaCount = 0;
  let structuralDifferencesCount = 0;

  let hasComponents = false;
  let hasDynamicZones = false;
  let hasRelations = false;
  let hasMedia = false;

  for (const [key, field] of Object.entries(schema.fields)) {
    // If key was not in applied payload, verify it remained identical to original document
    const isTargeted = key in appliedPayload;
    const expected = isTargeted ? appliedPayload[key] : originalDoc?.[key];
    const actual = savedDoc?.[key];

    switch (field.category) {
      case 'scalar': {
        const normExpected = normalizeVal(expected);
        const normActual = normalizeVal(actual);
        if (normExpected !== null && normActual !== normExpected) {
          // Allow number-to-number or string formatting equivalences
          if (String(normExpected) !== String(normActual)) {
            diffs.push({
              path: key,
              expected: normExpected,
              actual: normActual,
              message: `Scalar value mismatch on "${key}"`,
            });
            scalarOk = false;
            structuralDifferencesCount++;
          }
        }
        break;
      }

      case 'component_single':
      case 'component_repeatable': {
        hasComponents = true;
        if (field.category === 'component_repeatable') {
          const expArr = Array.isArray(expected) ? expected : [];
          const actArr = Array.isArray(actual) ? actual : [];
          if (expArr.length !== actArr.length) {
            diffs.push({
              path: key,
              expected: `Array of length ${expArr.length}`,
              actual: `Array of length ${actArr.length}`,
              message: `Repeatable component length mismatch on "${key}"`,
            });
            componentsOk = false;
            structuralDifferencesCount++;
          }
        }
        break;
      }

      case 'dynamiczone': {
        hasDynamicZones = true;
        const expBlocks = Array.isArray(expected) ? expected : [];
        const actBlocks = Array.isArray(actual) ? actual : [];
        if (expBlocks.length !== actBlocks.length) {
          diffs.push({
            path: key,
            expected: `Dynamic zone of length ${expBlocks.length}`,
            actual: `Dynamic zone of length ${actBlocks.length}`,
            message: `Dynamic zone count mismatch on "${key}"`,
          });
          dynamicZonesOk = false;
          structuralDifferencesCount++;
        } else {
          // Verify __component discriminator tags and order
          for (let b = 0; b < expBlocks.length; b++) {
            const expComp = expBlocks[b]?.__component;
            const actComp = actBlocks[b]?.__component;
            if (expComp !== actComp) {
              diffs.push({
                path: `${key}[${b}].__component`,
                expected: expComp || '(missing __component)',
                actual: actComp || '(missing __component)',
                message: `Dynamic zone block type mismatch at position ${b}: expected "${expComp}", found "${actComp || 'missing __component'}"`,
              });
              dynamicZonesOk = false;
              structuralDifferencesCount++;
            }
          }
        }
        break;
      }

      case 'relation_to_one':
      case 'relation_to_many': {
        hasRelations = true;
        if (isTargeted && expected && typeof expected === 'object' && expected.set) {
          const expectedIds: string[] = expected.set || [];
          if (field.category === 'relation_to_many') {
            const actualIds = Array.isArray(actual)
              ? actual.map((item: any) => String(item?.documentId || item?.id || item)).filter(Boolean)
              : [];
            const missing = expectedIds.filter((id) => !actualIds.includes(id));
            if (missing.length > 0) {
              diffs.push({
                path: key,
                expected: expectedIds,
                actual: actualIds,
                message: `Missing relations on "${key}": ${missing.join(', ')}`,
              });
              relationsOk = false;
              invalidRelationsCount += missing.length;
            }
          }
        }
        break;
      }

      case 'media_single':
      case 'media_to_many': {
        hasMedia = true;
        if (isTargeted && expected !== null && expected !== undefined) {
          const expectedIds = Array.isArray(expected) ? expected : [expected];
          const actualIds = Array.isArray(actual)
            ? actual.map((f: any) => f?.id || f).filter(Boolean)
            : actual?.id ? [actual.id] : [];
          const missing = expectedIds.filter((id: number) => !actualIds.includes(id));
          if (missing.length > 0) {
            diffs.push({
              path: key,
              expected: expectedIds,
              actual: actualIds,
              message: `Missing media references on "${key}"`,
            });
            mediaOk = false;
            missingMediaCount += missing.length;
          }
        }
        break;
      }

      default:
        break;
    }
  }

  const docId = String(savedDoc?.documentId || originalDoc?.documentId || 'unknown');
  const title = String(savedDoc?.title || savedDoc?.name || `Entry #${docId}`);
  const status = diffs.length === 0 ? 'SUCCESS' : diffs.length <= 2 ? 'WARNING' : 'FAILED';

  return {
    documentId: docId,
    title,
    status,
    scalarFields: scalarOk ? 'Verified' : 'Mismatch',
    components: hasComponents ? (componentsOk ? 'Verified' : 'Mismatch') : 'N/A',
    dynamicZones: hasDynamicZones ? (dynamicZonesOk ? 'Verified' : 'Mismatch') : 'N/A',
    relations: hasRelations ? (relationsOk ? 'Verified' : 'Mismatch') : 'N/A',
    media: hasMedia ? (mediaOk ? 'Verified' : 'Mismatch') : 'N/A',
    missingDataCount,
    invalidRelationsCount,
    missingMediaCount,
    structuralDifferencesCount,
    diffs,
  };
}
