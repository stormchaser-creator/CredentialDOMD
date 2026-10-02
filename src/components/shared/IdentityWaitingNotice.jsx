import { useApp } from "../../context/AppContext";

/**
 * The identity check had no answer at launch (a weak signal): the records on
 * screen are this device's copy, read only, and nothing can be saved until
 * the check answers. AppContext asks again on its own (identity retry) and
 * this goes away when it does, so it offers nothing to tap. It is the one
 * message on screen while that lasts: LaunchAccessNotice says nothing then,
 * and the read-only records view adds no membership line of its own (lab,
 * release goal2: "Reload to reconnect your account" sat under "Trying again
 * on its own"). It used to be a full screen with no records and a Reload
 * button, which stayed until he tapped it (IPHONE weak network).
 *
 * `deviceCopyBehind`: the copy was left by a page whose last save never
 * landed, so it may lack the latest change; said, never hidden.
 */
export default function IdentityWaitingNotice() {
  const { identityWaiting, deviceCopyBehind, theme: T } = useApp();
  if (!identityWaiting) return null;
  return (
    <div role="status" data-identity-waiting="" style={{
      margin: "0 0 12px", padding: "10px 12px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.45,
      backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, color: T.text,
    }}>
      {identityWaitingText({ behind: deviceCopyBehind })}
      <span style={{ display: "block", marginTop: 4, fontSize: 12, color: T.textMuted }}>Support reference: {identityWaiting.supportReference}</span>
    </div>
  );
}

/** What IdentityWaitingNotice says. */
function identityWaitingText({ behind = false } = {}) {
  return "The connection is too weak to reach your account right now. You are seeing the copy saved on this device, read only for now."
    + (behind ? " Your latest changes may not be in this copy yet." : "")
    + " The app keeps trying on its own, so there is nothing to tap.";
}
