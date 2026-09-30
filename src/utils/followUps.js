/** A record's follow-ups (Home's "Follow up" on an alert), newest first. */
export function followUpsFor(followUps, item) {
  return (followUps || [])
    .filter(f => f && f.itemId === item?.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
