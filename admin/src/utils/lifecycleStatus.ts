export interface Entry {
  id?: number | string;
  documentId?: string;
  slug?: string;
  status?: string;
  publishedAt?: string | null;
  published_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  [key: string]: any;
}

export interface CollectionModel {
  uid: string;
  draftAndPublish?: boolean;
  [key: string]: any;
}

export interface PendingBatch {
  status: string;
  payload?: {
    selectedEntries?: Array<{ documentId?: string; id?: string | number; [key: string]: any }>;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface LifecycleStatusResult {
  status: 'pending_review' | 'modified' | 'published' | 'draft' | 'unknown';
  label: string;
  badgeColor: string;
  textColor: string;
}

/**
 * Determines the real lifecycle status of an entry (Pending Review, Modified, Published, Draft, Unknown).
 */
export function getEntryLifecycleStatus(
  entry: Entry,
  col: CollectionModel | null,
  pendingBatches: PendingBatch[] = []
): LifecycleStatusResult {
  // 1. Check if this entry is pending review in any pending_approval batch
  const isPendingApproval = pendingBatches.some((b) => {
    if (b.status !== 'pending_approval') return false;
    const targets = b.payload?.selectedEntries || [];
    return targets.some((t) => (entry.documentId && t.documentId === entry.documentId) || String(t.documentId) === String(entry.id));
  });

  if (isPendingApproval) {
    return {
      status: 'pending_review',
      label: 'Pending Review',
      badgeColor: 'warning100',
      textColor: 'warning700',
    };
  }

  // 2. Collections without draft/publish support are always Published
  if (col && col.draftAndPublish === false) {
    return {
      status: 'published',
      label: 'Published',
      badgeColor: 'success100',
      textColor: 'success700',
    };
  }

  // 3. Check explicit status property (populated by backend or metadata)
  if (entry.status === 'modified') {
    return {
      status: 'modified',
      label: 'Modified',
      badgeColor: 'primary100',
      textColor: 'primary700',
    };
  }

  if (entry.status === 'draft') {
    return {
      status: 'draft',
      label: 'Draft',
      badgeColor: 'neutral150',
      textColor: 'neutral700',
    };
  }

  if (entry.status === 'published') {
    return {
      status: 'published',
      label: 'Published',
      badgeColor: 'success100',
      textColor: 'success700',
    };
  }

  if (entry.status === 'unknown') {
    return {
      status: 'unknown',
      label: 'Unknown',
      badgeColor: 'neutral200',
      textColor: 'neutral600',
    };
  }

  // 4. Missing required identifiers -> cannot be resolved safely
  if (!entry.documentId && !entry.id && !entry.slug) {
    return {
      status: 'unknown',
      label: 'Unknown',
      badgeColor: 'neutral200',
      textColor: 'neutral600',
    };
  }

  // 5. Fallback: check publication timestamps
  if (entry.publishedAt) {
    if (entry.updatedAt && new Date(entry.updatedAt).getTime() > new Date(entry.publishedAt).getTime()) {
      return {
        status: 'modified',
        label: 'Modified',
        badgeColor: 'primary100',
        textColor: 'primary700',
      };
    }
    return {
      status: 'published',
      label: 'Published',
      badgeColor: 'success100',
      textColor: 'success700',
    };
  }

  return {
    status: 'draft',
    label: 'Draft',
    badgeColor: 'neutral150',
    textColor: 'neutral700',
  };
}
