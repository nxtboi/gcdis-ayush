import * as fs from 'fs';
import * as path from 'path';

/**
 * Staff management (feature): Users and Roles tab of the staff console. String-level checks of the
 * actions menu, the Change Role and Deactivate / Reactivate dialogs and their wiring.
 */
describe('Staff management: staff console', () => {
  const componentsDir = path.resolve(__dirname, '..', 'apps', 'admin', 'src', 'app', '_components');
  const read = (name: string) => fs.readFileSync(path.join(componentsDir, name), 'utf-8');
  const management = read('StaffManagement.tsx');
  const usersTab = read('UsersTab.tsx');
  const page = fs.readFileSync(path.resolve(componentsDir, '..', 'page.tsx'), 'utf-8');
  const apiClient = fs.readFileSync(path.resolve(componentsDir, '..', '..', 'lib', 'api-client.ts'), 'utf-8');

  test('role and status requests use PATCH on the new endpoints through adminFetch', () => {
    expect(management).toMatch(/adminFetch<StaffUser>\(`\/auth\/users\/\$\{encodeURIComponent\(user\.id\)\}\/role`/);
    expect(management).toMatch(/adminFetch<StaffUser>\(`\/auth\/users\/\$\{encodeURIComponent\(user\.id\)\}\/status`/);
    expect(management.match(/method: 'PATCH'/g)).toHaveLength(2);
    expect(management).toContain('JSON.stringify({ role })');
    expect(management).toContain('JSON.stringify({ isActive: !deactivating, ...(trimmed ? { reason: trimmed } : {}) })');
  });

  test('step-up is handled by the API client (403 STEP_UP_REQUIRED opens the identity dialog and retries once)', () => {
    expect(apiClient).toContain("export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED';");
    expect(apiClient).toMatch(/isStepUpRequired\(res\.status, errorData\) && !options\._isStepUpRetry/);
    // A cancelled confirmation is reported with the client's formal message
    expect(management).toContain('if (isStepUpCancelledError(err)) return err.message;');
  });

  test('the Change Role dialog lists only staff roles with a formal explanation of each', () => {
    for (const role of ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']) {
      expect(management).toContain(`value: '${role}'`);
    }
    expect(management).not.toContain("value: 'TEAM_CAPTAIN'");
    expect(management).toContain('Confirm Role Change');
    expect(management).toContain("ends every active session of this account");
    // The unchanged role cannot be submitted
    expect(management).toContain('disabled={busy || unchanged || !selected}');
  });

  test('the status dialog has an optional reason limited to 300 characters', () => {
    expect(management).toContain('export const STATUS_REASON_MAX = 300;');
    expect(management).toContain('maxLength={STATUS_REASON_MAX}');
    expect(management).toContain("'Deactivate Account'");
    expect(management).toContain("'Reactivate Account'");
    expect(management).toContain('(optional, recorded in the audit log)');
  });

  test('the actions menu follows the menu button pattern and is disabled on the signed-in user\'s row', () => {
    expect(management).toContain('aria-haspopup="menu"');
    expect(management).toContain('role="menu"');
    expect(management).toContain('role="menuitem"');
    expect(management).toMatch(/event\.key === 'Escape'/);
    expect(management).toContain('You cannot change the role or status of your own account.');
    expect(usersTab).toContain('isSelf={!!currentUserId && u.id === currentUserId}');
  });

  test('dialogs reuse the accessible Modal and the console motion vocabulary', () => {
    expect(management).toMatch(/import \{ BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, Modal \} from '\.\/Modal';/);
    expect(management).toContain('EASE_OUT');
    expect(management).toContain('busy={busy}');
  });

  test('the Users and Roles tab shows actions only to a Super Administrator and keeps the status badge', () => {
    expect(usersTab).toContain("const canManage = canCreate;");
    expect(usersTab).toContain('{canManage && (');
    expect(usersTab).toContain("{active ? 'Active' : 'Deactivated'}");
    expect(usersTab).toContain('<ChangeRoleDialog');
    expect(usersTab).toContain('<AccountStatusDialog');
    expect(usersTab).toContain('<Notice tone="success" message={manageSuccess}');
  });

  test('the page passes the signed-in user id and merges the updated account into the list', () => {
    expect(page).toContain('currentUserId={currentUser?.id}');
    expect(page).toMatch(/onUserUpdated=\{\(updated\) =>\s*setUserList\(\(prev\) => prev\.map\(\(u\) => \(u\.id === updated\.id \? \{ \.\.\.u, \.\.\.updated \} : u\)\)\)/);
  });
});
