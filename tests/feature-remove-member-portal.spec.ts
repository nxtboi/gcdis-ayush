import * as fs from 'fs';
import * as path from 'path';
import { POST_APPROVAL_STATUSES } from '@gcdis/shared';

const portalDir = path.join(__dirname, '..', 'apps', 'web', 'src', 'app', 'portal');
const read = (...parts: string[]) => fs.readFileSync(path.join(portalDir, ...parts), 'utf-8');

/** Visible strings in a TSX source (JSX text and string literals), for copy-style checks. */
function visibleCopy(src: string): string {
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = withoutComments.match(/'[^'\n]*'|`[^`]*`|>[^<>{}\n]+</g) ?? [];
  return literals.join('\n');
}

describe('Feature: remove a team member from the portal', () => {
  const tab = read('_components', 'MembersTab.tsx');
  const modal = read('_components', 'MemberRemoveModal.tsx');
  const page = read('page.tsx');
  const types = read('_components', 'types.ts');

  test('MembersTab offers Remove for non-captain members only, in both layouts', () => {
    expect(tab).toMatch(/onRemove: \(member: TeamMember\) => void/);
    expect(tab).toMatch(/member\.roleType === 'captain'[^\n]*return null/);
    expect(tab.match(/\{renderRemoveButton\(member\)\}/g)).toHaveLength(2);
    expect(tab).toContain('aria-label={`Remove ${member.name} from the team`}');
  });

  test('Remove is disabled with an explanation while the roster is locked', () => {
    expect(tab).toMatch(/disabled=\{Boolean\(removeDisabledReason\)\}/);
    expect(tab).toMatch(/title=\{removeDisabledReason \?\? undefined\}/);
    expect(tab).toContain('id="members-remove-hint"');
    expect(page).toContain('removeLockedReason={ROSTER_LOCKED_STATUSES.has(teamInfo.status) ? ROSTER_LOCKED_MESSAGE : null}');
  });

  test('the portal locked stages match the shared POST_APPROVAL_STATUSES used by the API', () => {
    const set = types.match(/ROSTER_LOCKED_STATUSES = new Set\(\[([^\]]+)\]\)/);
    expect(set).not.toBeNull();
    const statuses = set![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(statuses.sort()).toEqual([...POST_APPROVAL_STATUSES].sort());
  });

  test('the confirmation dialog calls DELETE, shows busy state and API errors as returned', () => {
    expect(modal).toContain("Remove {member.name} from the team? This cannot be undone.");
    expect(modal).toContain("method: 'DELETE'");
    expect(modal).toMatch(/\/teams\/\$\{encodeURIComponent\(teamInfo\.teamRecordId\)\}\/members\/\$\{encodeURIComponent\(member\.id\)\}/);
    expect(modal).toContain("busy ? 'Removing…' : 'Remove Member'");
    expect(modal).toMatch(/setError\(err instanceof Error && err\.message \? err\.message/);
    expect(modal).toContain('role="alert"');
    expect(modal).toContain("from '@/components/Modal'");
  });

  test('a successful removal updates the roster count at once and shows a formal notice', () => {
    expect(page).toContain('setMembers((current) => current.filter((m) => m.id !== removed.id));');
    expect(page).toContain('setMemberNotice(`${removed.name} has been removed from the team.`);');
    expect(page).toMatch(/\{memberNotice && \(\s*<motion\.div\s+key="member-notice"\s+role="status"/);
    expect(page).toContain('setSelectedMemberForRemove(null);');
  });

  test('the new copy is formal (no exclamation marks)', () => {
    for (const src of [modal, tab]) {
      expect(visibleCopy(src)).not.toMatch(/[A-Za-z.]!(\s|'|`|<|$)/);
    }
    expect(types).toContain(
      "'The roster is final once the registration has been approved. Please contact the GCDIS Secretariat if a change is required.'"
    );
  });
});
