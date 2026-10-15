// Intentional fault injection is declared by exact message and bounded count.
// Everything else is a test failure, even when the happy-path assertions pass.
export function allowPageError(report, message, maxCount = 1) {
  if (typeof message !== 'string' || !message.trim() || !Number.isInteger(maxCount) || maxCount < 1 || maxCount > 10) {
    throw new Error('Expected browser errors need an exact nonempty message and a count from 1 to 10');
  }
  (report.expectedPageErrors ||= []).push({ message: message.slice(0, 400), maxCount });
}

export function unexpectedPageErrors(report) {
  const remaining = (report.expectedPageErrors || []).map(rule => ({ ...rule }));
  return (report.pageErrors || []).filter(message => {
    const rule = remaining.find(rule => rule.message === message && rule.maxCount > 0);
    if (!rule) return true;
    rule.maxCount -= 1;
    return false;
  });
}
