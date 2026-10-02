import { useApp } from "../../context/AppContext";

/**
 * The identity check had no answer at launch (a weak signal): the records on
 * screen are this device's copy, and nothing can be saved until the check
 * answers. AppContext asks again on its own (identity retry) and this goes
 * away when it does. It used to be a full screen with no records and a
 * Reload button, which stayed until he tapped it (IPHONE weak network).
 */
export default function IdentityWaitingNotice() {
  const { identityWaiting, theme: T } = useApp();
  if (!identityWaiting) return null;
  return (
    <div role="status" data-identity-waiting="" style={{
      margin: "0 0 12px", padding: "10px 12px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.45,
      backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, color: T.text,
    }}>
      The connection is too weak to confirm your account right now. These are the records saved on this device, and changes wait until it connects. Trying again on its own.
      <span style={{ display: "block", marginTop: 4, fontSize: 12, color: T.textMuted }}>Support reference: {identityWaiting.supportReference}</span>
    </div>
  );
}
