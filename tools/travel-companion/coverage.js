// Metadata only: no document text, URLs, credentials or access codes.
export const COVERAGE_INSTRUCTIONS = 'Before answering from a shared guide or asking for missing details, read the entire available text, inventory embedded resources, record document-review, then run document-check for the relevant topics and resources. Reuse documented facts instead of asking again. A detected link is not viewed media. Review only relevant media; if blocked, state the precise limitation. Never infer a street, entrance or access procedure from an unreviewed video. Review metadata is agent-reported, not independent proof. Keep secrets and personalized URLs out of shared summaries.';
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid document metadata fields');
}
function label(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(value)) throw new Error('Use short topic/resource labels, not text or secrets');
  return value;
}
function artifact(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid evidence artifact id');
  return value;
}
function labels(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Expected at most 30 labels');
  return [...new Set(value.map(label))];
}
export function normalizeReview(data, sourceArtifactId) {
  fields(data, ['textStatus', 'textEvidenceArtifactId', 'topics', 'resources']);
  if (!['unread', 'partial', 'complete'].includes(data.textStatus)) throw new Error('Invalid textStatus');
  const topics = labels(data.topics || []);
  if (data.textStatus === 'unread' && (topics.length || data.textEvidenceArtifactId)) throw new Error('Unread text cannot have coverage evidence');
  const textEvidenceArtifactId = data.textStatus === 'unread' ? null : artifact(data.textEvidenceArtifactId);
  if (!Array.isArray(data.resources || []) || (data.resources || []).length > 30) throw new Error('Expected at most 30 resources');
  const resources = (data.resources || []).map(r => {
    fields(r, ['id', 'kind', 'status', 'evidenceArtifactId']);
    if (!['video', 'image', 'document', 'link'].includes(r.kind) || !['detected', 'reviewed', 'blocked'].includes(r.status)) throw new Error('Invalid resource kind/status');
    if (r.status !== 'reviewed' && r.evidenceArtifactId) throw new Error('Only reviewed resources may have review evidence');
    return { id: label(r.id), kind: r.kind, status: r.status, evidenceArtifactId: r.status === 'reviewed' ? artifact(r.evidenceArtifactId) : null };
  });
  if (new Set(resources.map(r => r.id)).size !== resources.length) throw new Error('Duplicate resource ids');
  return { sourceArtifactId: artifact(sourceArtifactId), textStatus: data.textStatus, textEvidenceArtifactId, topics, resources };
}
export function reviewArtifacts(review) {
  return [...new Set([review.sourceArtifactId, review.textEvidenceArtifactId, ...review.resources.map(r => r.evidenceArtifactId)].filter(Boolean))];
}
export function currentReview(trip, item) {
  const review = trip.documentReviews?.[item.id];
  return review && review.sourceArtifactId === item.sourceArtifactId ? review : null;
}
export function sharedReviews(trip, includePrivate = false) {
  return Object.values(trip.items).filter(i => includePrivate || i.visibility === 'shared').flatMap(i => {
    const review = currentReview(trip, i);
    return review ? [{ itemId: i.id, ...review }] : [];
  });
}
export function checkDocument(trip, item, data) {
  fields(data, ['topics', 'resources']);
  const topics = labels(data.topics || []), resources = labels(data.resources || []);
  if (!topics.length && !resources.length) throw new Error('Specify relevant topics or resources');
  const review = currentReview(trip, item);
  const missingTopics = topics.filter(t => !review?.topics.includes(t));
  const unreviewedResources = resources.filter(id => !review?.resources.some(r => r.id === id && r.status === 'reviewed'));
  const textComplete = review?.textStatus === 'complete';
  return { itemId: item.id, ready: textComplete && !missingTopics.length && !unreviewedResources.length,
    textStatus: review?.textStatus || 'unread', missingTopics, unreviewedResources,
    nextStep: !textComplete ? 'Read all available text before asking for missing details.' : unreviewedResources.length ? 'Review relevant media or explicitly disclose the limitation.' : missingTopics.length ? 'Check the source; ask only for details absent from the fully read text.' : 'Use reviewed evidence without repeating questions.',
    evidenceType: 'agent-reported', instructions: COVERAGE_INSTRUCTIONS };
}
