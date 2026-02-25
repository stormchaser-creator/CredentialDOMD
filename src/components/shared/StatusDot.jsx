import { memo } from "react";
import { STATUS_COLORS } from "../../utils/helpers";

function StatusDot({ color }) {
  const c = STATUS_COLORS[color] || STATUS_COLORS.gray;
  return <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c, flexShrink: 0 }} />;
}

export default memo(StatusDot);
