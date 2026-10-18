import type { Core } from '@strapi/strapi';

const FIELDS_TO_IGNORE = [
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'strapi_stage',
  'strapi_assignee',
];

/**
 * Builds a recursive Strapi 5 populate tree for deep nested components, relations, and media
 */
function buildHistoryPopulate(
  attributes: Record<string, any>,
  allComponents: Record<string, any>,
  depth = 0
): Record<string, any> | undefined {
  if (depth > 5) return undefined;
  const populate: Record<string, any> = {};

  for (const [key, def] of Object.entries(attributes || {}) as any[]) {
    if (def.type === 'component' && def.component) {
      const comp = allComponents[def.component];
      if (comp?.attributes) {
        const subPopulate = buildHistoryPopulate(comp.attributes, allComponents, depth + 1);
        if (subPopulate && Object.keys(subPopulate).length > 0) {
          populate[key] = {
            populate: subPopulate,
          };
        } else {
          populate[key] = true;
        }
      } else {
        populate[key] = true;
      }
    } else if (def.type === 'dynamiczone') {
      populate[key] = true;
    } else if (def.type === 'relation' || def.type === 'media') {
      populate[key] = true;
    }
  }

  return Object.keys(populate).length > 0 ? populate : undefined;
}

let cachedAdminUserId: number | null = null;

export interface ContentHistoryRecordOptions {
  uid: string;
  documentId: string;
  userId?: number | string | null;
  statusOverride?: 'draft' | 'published' | 'modified';
}

/**
 * Records a Content History version in Strapi's plugin::content-manager.history-version
 * so that any bulk-updated, bulk-published, rolled-back, or CSV-imported record accurately
 * reflects in Strapi's Content History timeline in Content Manager.
 */
export async function recordContentHistoryVersion(
  strapi: any,
  options: ContentHistoryRecordOptions
): Promise<void> {
  const { uid, documentId, userId, statusOverride } = options;

  if (!uid || !uid.startsWith('api::') || !documentId) {
    return;
  }

  try {
    const historyQuery = strapi.db?.query?.('plugin::content-manager.history-version');
    if (!historyQuery) {
      return;
    }

    const model = strapi.getModel?.(uid);
    if (!model) {
      return;
    }

    // 1. Fetch updated document state directly via db.query to avoid document service middleware recursion
    let entry: any = null;
    try {
      entry = await strapi.db.query(uid).findOne({
        where: { documentId },
        populate: true,
      });
    } catch {
      try {
        const populateOption = buildHistoryPopulate(model.attributes || {}, strapi.components || {});
        entry = await strapi.documents(uid as any).findOne({
          documentId,
          ...(populateOption ? { populate: populateOption } : {}),
        });
      } catch {
        entry = null;
      }
    }

    if (!entry) {
      return;
    }

    // 2. Prepare sanitized schema for diff inspection and restore
    const attributesSchema = model.attributes || {};
    const sanitizedSchema = Object.fromEntries(
      Object.entries(attributesSchema).filter(([k]) => !FIELDS_TO_IGNORE.includes(k))
    );

    // 3. Prepare sanitized data snapshot
    const sanitizedData = Object.fromEntries(
      Object.entries(entry).filter(([k]) => !FIELDS_TO_IGNORE.includes(k) && k !== 'id')
    );

    // 4. Calculate version status
    let status: 'draft' | 'published' | 'modified' = statusOverride || 'published';
    if (!statusOverride) {
      const hasDraftAndPublish = Boolean(model.options?.draftAndPublish);
      if (hasDraftAndPublish) {
        try {
          const docMetaService = strapi.plugin('content-manager')?.service('document-metadata');
          if (docMetaService) {
            const meta = await docMetaService.getMetadata(uid, entry);
            status = docMetaService.getStatus(entry, meta.availableStatus);
          } else {
            status = entry.publishedAt ? 'published' : 'draft';
          }
        } catch {
          status = entry.publishedAt ? 'published' : 'draft';
        }
      } else {
        status = 'published';
      }
    }

    // 5. Resolve creator ID
    let authorId = userId;
    if (!authorId) {
      authorId = strapi.requestContext?.get?.()?.state?.user?.id || null;
    }
    let numericUserId = authorId ? Number(authorId) : null;
    if (!numericUserId || isNaN(numericUserId)) {
      if (cachedAdminUserId) {
        numericUserId = cachedAdminUserId;
      } else {
        try {
          const firstAdmin = await strapi.db?.query?.('admin::user')?.findOne?.({ select: ['id'] });
          if (firstAdmin?.id) {
            cachedAdminUserId = Number(firstAdmin.id);
            numericUserId = cachedAdminUserId;
          }
        } catch {}
      }
    }

    // 6. Insert record into plugin::content-manager.history-version (strapi_history_versions)
    await historyQuery.create({
      data: {
        contentType: uid,
        relatedDocumentId: documentId,
        locale: entry.locale || null,
        status,
        data: sanitizedData,
        schema: sanitizedSchema,
        createdAt: new Date(),
        ...(numericUserId && !isNaN(numericUserId) ? { createdBy: numericUserId } : {}),
      },
    });
  } catch (err: any) {
    strapi.log?.warn?.(`[bulk-updater] Non-blocking Content History notice for ${uid}/${documentId}: ${err?.message}`);
  }
}

/**
 * Bulk version recorder: processes an array of document IDs in parallel batches
 */
export async function recordContentHistoryVersionsBatch(
  strapi: any,
  items: ContentHistoryRecordOptions[]
): Promise<void> {
  if (!items || items.length === 0) return;
  const BATCH_SIZE = 10;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE);
    await Promise.all(slice.map((item) => recordContentHistoryVersion(strapi, item)));
  }
}

export default {
  recordContentHistoryVersion,
  recordContentHistoryVersionsBatch,
};
