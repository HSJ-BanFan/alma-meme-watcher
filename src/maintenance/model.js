import { createHash } from 'node:crypto';

export const maintenanceFields = Object.freeze(['usage_context', 'avoid_when']);
export const maintenanceStatuses = Object.freeze(['updated', 'unchanged', 'conflict', 'deleted', 'rejected', 'failed']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digestPattern = /^[a-f0-9]{64}$/;

export function maintenanceError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

export function maintenanceDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

export function parseMaintenanceFields(fields = maintenanceFields) {
  if (!Array.isArray(fields) || !fields.length || fields.some((field) => !maintenanceFields.includes(field))) {
    throw maintenanceError('INVALID_OPTIONS', 'fields must contain usage_context or avoid_when.');
  }
  return maintenanceFields.filter((field) => fields.includes(field));
}

export function targetDigest(target) {
  return maintenanceDigest(Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'digest')));
}

export function parseMaintenanceTarget(target) {
  const invalid = () => { throw maintenanceError('INVALID_TARGET', 'The maintenance target snapshot is invalid.'); };
  if (!record(target) || target.version !== 1 || typeof target.canonical_term !== 'string' || !target.canonical_term.trim()
    || !record(target.source) || typeof target.source.kind !== 'string' || typeof target.source.url !== 'string'
    || typeof target.review_status !== 'string' || !record(target.evidence) || !record(target.expected)
    || !Array.isArray(target.fields) || target.fields.some((field) => !maintenanceFields.includes(field))
    || typeof target.digest !== 'string' || !digestPattern.test(target.digest)) invalid();
  const { term, metadata, metadata_template, metadata_schema, term_reviews, candidate_reviews } = target.expected;
  if (!record(term) || term.term !== target.canonical_term || typeof term.aliases !== 'string'
    || typeof term.meaning !== 'string' || !term.meaning.trim() || term.source !== target.source.kind
    || (metadata !== null && (!record(metadata) || metadata.term !== target.canonical_term))
    || !record(metadata_template) || metadata_template.term !== target.canonical_term
    || (metadata_schema !== null && (typeof metadata_schema !== 'string' || !digestPattern.test(metadata_schema)))
    || !Array.isArray(term_reviews) || !Array.isArray(candidate_reviews)) invalid();
  for (const row of term_reviews) {
    if (!record(row) || typeof row.term !== 'string' || typeof row.status !== 'string' || typeof row.source_url !== 'string') invalid();
  }
  for (const row of candidate_reviews) {
    if (!record(row) || typeof row.term !== 'string' || typeof row.verdict !== 'string') invalid();
  }
  const review = term_reviews.find((row) => row.term === target.canonical_term);
  if (target.source.url !== (review?.source_url ?? '') || target.review_status !== (review?.status ?? 'unreviewed_legacy')) invalid();
  const meta = metadata ?? metadata_template;
  if (maintenanceFields.some((field) => typeof meta[field] !== 'string')
    || target.evidence.meaning !== term.meaning || target.evidence.origin !== term.origin
    || target.evidence.example !== term.example || target.evidence.tags !== term.tags
    || target.evidence.published_at !== meta.published_at
    || !Array.isArray(target.evidence.aliases) || target.evidence.aliases.some((alias) => typeof alias !== 'string')
    || targetDigest(target) !== target.digest) invalid();
  return target;
}

export function parseMaintenanceValue(value) {
  if (typeof value !== 'string') throw maintenanceError('INVALID_CONTENT', 'The proposed field must be plain text.');
  const text = value.trim().normalize('NFC');
  const characters = [...text];
  const placeholder = /\b(?:todo|tbd|placeholder|lorem ipsum|n\/?a|undefined|null)\b|待(?:补充|完善|生成|填写)|暂无(?:具体|相关|信息|资料)|无法(?:判断|提供|确定)|不知道|示例(?:内容|文本)|请(?:填写|补充)|<[^>]+>|\{\{[^}]+\}\}/iu;
  if (characters.length < 8 || characters.length > 600 || /[\u0000-\u0008\u000b-\u001f\u007f]|```|https?:\/\//iu.test(text)
    || placeholder.test(text) || new Set(text.replace(/[\s\p{P}\p{S}]/gu, '')).size < 4) {
    throw maintenanceError('INVALID_CONTENT', 'The proposed field is too short, too long, or contains placeholder/unsupported content.');
  }
  return text;
}

export function parseGeneratedValue(output, field) {
  if (!record(output) || Object.keys(output).length !== 1 || !Object.hasOwn(output, field)) {
    throw maintenanceError('MODEL_OUTPUT_INVALID', 'The model must return exactly the requested JSON field.', true);
  }
  try {
    return parseMaintenanceValue(output[field]);
  } catch {
    throw maintenanceError('MODEL_OUTPUT_INVALID', 'The model returned invalid or placeholder field content.', true);
  }
}

export const patchId = (target, field) => maintenanceDigest({ target: target.digest, field });
export const reviewId = (target) => maintenanceDigest({ target: target.digest, operation: 'review' });

export function draftPatch(target, field, value) {
  return { version: 1, id: patchId(target, field), target, field, value: parseMaintenanceValue(value), approval: 'pending' };
}

function requireApproval(approval) {
  if (approval === 'rejected') throw maintenanceError('APPROVAL_REJECTED', 'The operator rejected this record.');
  if (approval !== 'approved') throw maintenanceError('APPROVAL_REQUIRED', 'An explicit operator-approved record is required.');
}

export function parseMaintenancePatch(patch) {
  if (!record(patch) || patch.version !== 1 || !maintenanceFields.includes(patch.field)) {
    throw maintenanceError('INVALID_PATCH', 'The metadata patch is invalid.');
  }
  requireApproval(patch.approval);
  const target = parseMaintenanceTarget(patch.target);
  const meta = target.expected.metadata ?? target.expected.metadata_template;
  if (patch.id !== patchId(target, patch.field) || !target.fields.includes(patch.field) || meta[patch.field].trim()) {
    throw maintenanceError('INVALID_PATCH', 'The patch must bind an empty field in its original target snapshot.');
  }
  return { ...patch, value: parseMaintenanceValue(patch.value) };
}

export function draftReview(target, status) {
  if (!['accepted', 'rejected'].includes(status)) throw maintenanceError('INVALID_REVIEW', 'Review status must be accepted or rejected.');
  return { version: 1, id: reviewId(target), target, status, approval: 'pending' };
}

export function parseMaintenanceReview(review) {
  if (!record(review) || review.version !== 1 || !['accepted', 'rejected'].includes(review.status)) {
    throw maintenanceError('INVALID_REVIEW', 'The review record is invalid.');
  }
  requireApproval(review.approval);
  const target = parseMaintenanceTarget(review.target);
  if (review.id !== reviewId(target)) throw maintenanceError('INVALID_REVIEW', 'The review record does not bind its snapshot.');
  return review;
}

export function maintenanceReport(outcomes, error) {
  const counts = Object.fromEntries(maintenanceStatuses.map((status) => [status, outcomes.filter((item) => item.status === status).length]));
  return { outcomes, counts, ...(error ? { error } : {}) };
}
