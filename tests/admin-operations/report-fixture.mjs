export function reportFixture(days = 30) {
  const end = new Date('2026-09-24T12:30:00.000Z');
  const start = new Date(end);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return { day: date.toISOString().slice(0, 10), signups: 2, page_views: 10, tickets: 1, errors: index >= days - 6 ? 1 : 0 };
  });
  return { schema_version: 1, generated_at: end.toISOString(), period_start: start.toISOString(), period_end: end.toISOString(), days,
    accounts: { total: 1000, active: 710, new_in_period: days * 2 },
    support: { open: 10, urgent: 2, waiting_approval: 3, oldest_open_at: '2026-08-20T08:00:00.000Z' },
    errors: { in_period: 6 }, daily };
}
