'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutDashboard,
  Paintbrush,
  Users,
  ShieldCheck,
  Radio,
  Clock,
  UserCheck,
  Award,
  Handshake,
  Images,
  Clapperboard,
  Building2,
  LayoutList,
  LockKeyhole,
  Menu
} from 'lucide-react';
import {
  adminFetch,
  downloadAuditCsv,
  isSessionExpiredError,
  keepSessionAlive,
  noteUserActivity,
  SESSION_IDLE_TIMEOUT_CODE,
  setSessionExpiredHandler,
  toPagedResult
} from '../lib/api-client';
import { formalMessage } from '../lib/messages';
import { UPLOAD_LIMITS, canOpenTab, formatBytes, validateImageFile } from './_components/contentTypes';
import StepUpDialog from './_components/StepUpDialog';
import { LoginScreen, PasswordChangeScreen, RecoveryCodesScreen } from './_components/AuthScreens';
import { passwordPolicyError } from '@/lib/password-policy';
import OverviewTab from './_components/OverviewTab';
import { ConfirmDialog } from './_components/Modal';
import { MotionProvider, Notice, TabPanel, Skeleton } from './_components/motion';
import type { PrizeUpdate } from './_components/PrizesTab';
import {
  DEFAULT_HERO_CONFIG,
  DEFAULT_HERO_TEXT,
  FAILSAFE_MAX_SECONDS,
  FIDA_BALL_LIMITS,
  fidaClassOf,
  heroConfigFrom,
  heroTextFrom,
  isStaffRole,
  roleLabel,
  statusLabel,
  type AdminRegistration,
  type AdminTab,
  type AuditLog,
  type Checklist,
  type ContentVersion,
  type CreatedStaff,
  type Fixture,
  type HeroConfig,
  type HeroText,
  type InspectionRecord,
  type PageState,
  type PrizePool,
  type StaffUser
} from './_components/types';
import PendingVerificationBadge from './_components/PendingVerificationBadge';
import AwaitingReviewBadge, { notifyRegistrationsChanged } from './_components/AwaitingReviewBadge';
import AdminSidebar, { type SidebarGroup } from './_components/AdminSidebar';

/** Placeholder shown while a tab's code is loading: the same card shape, so nothing shifts. */
function TabLoading() {
  return (
    <div className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-hidden="true">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3 w-80 max-w-full" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

// Tab panels other than the default overview are loaded on demand.
const CmsHeroTab = dynamic(() => import('./_components/CmsHeroTab'), { loading: TabLoading });
const HomeSectionsTab = dynamic(() => import('./_components/HomeSectionsTab'), { loading: TabLoading });
const RegistrationsTab = dynamic(() => import('./_components/RegistrationsTab'), { loading: TabLoading });
const ScrutineeringTab = dynamic(() => import('./_components/ScrutineeringTab'), { loading: TabLoading });
const ScoringTab = dynamic(() => import('./_components/ScoringTab'), { loading: TabLoading });
const AuditTab = dynamic(() => import('./_components/AuditTab'), { loading: TabLoading });
const UsersTab = dynamic(() => import('./_components/UsersTab'), { loading: TabLoading });
const PrizesTab = dynamic(() => import('./_components/PrizesTab'), { loading: TabLoading });
const SponsorsTab = dynamic(() => import('./_components/SponsorsTab'), { loading: TabLoading });
const GalleryTab = dynamic(() => import('./_components/GalleryTab'), { loading: TabLoading });
const ChampionshipMediaTab = dynamic(() => import('./_components/ChampionshipMediaTab'), { loading: TabLoading });
const SiteInfoTab = dynamic(() => import('./_components/SiteInfoTab'), { loading: TabLoading });
const SecurityTab = dynamic(() => import('./_components/SecurityTab'), { loading: TabLoading });

type NavGroupId = 'event' | 'website' | 'administration';

const NAV_ITEMS: { id: AdminTab; label: string; title: string; group: NavGroupId; icon: React.ComponentType<{ className?: string }> }[] = [
  // Event
  { id: 'overview', label: 'Overview', title: 'Event Readiness', group: 'event', icon: LayoutDashboard },
  { id: 'registrations', label: 'Registrations', title: 'Team Registrations and Eligibility', group: 'event', icon: Users },
  { id: 'scrutineering', label: 'Technical Inspection', title: 'Technical Inspection (FIDA Specifications)', group: 'event', icon: ShieldCheck },
  { id: 'scoring', label: 'Match Scoring', title: 'Match Scoring', group: 'event', icon: Radio },
  { id: 'prizes', label: 'Prizes', title: 'Prize Pool Allocation', group: 'event', icon: Award },
  // Website
  { id: 'cms_hero', label: 'Home Page Hero', title: 'Home Page Hero Content and Background', group: 'website', icon: Paintbrush },
  { id: 'home_sections', label: 'Home Page Sections', title: 'Home Page Sections', group: 'website', icon: LayoutList },
  { id: 'site_info', label: 'Site Information', title: 'Site Information and Contact Details', group: 'website', icon: Building2 },
  { id: 'sponsors', label: 'Sponsors', title: 'Sponsors and Partners', group: 'website', icon: Handshake },
  { id: 'gallery', label: 'Gallery', title: 'Gallery', group: 'website', icon: Images },
  { id: 'championship_media', label: 'Championship Page', title: 'Championship Page Video and Photos', group: 'website', icon: Clapperboard },
  // Administration
  { id: 'users', label: 'Users and Roles', title: 'Staff Accounts and Roles', group: 'administration', icon: UserCheck },
  { id: 'security', label: 'Security', title: 'Account Security and Sessions', group: 'administration', icon: LockKeyhole },
  { id: 'audit', label: 'Audit Log', title: 'System Audit Log', group: 'administration', icon: Clock }
];

const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'event', label: 'Event' },
  { id: 'website', label: 'Website' },
  { id: 'administration', label: 'Administration' }
];

/**
 * Inactivity limit before automatic sign-out (the API enforces it too: ADMIN_IDLE_TIMEOUT_MIN, sent by
 * GET /auth/me as session.idleTimeoutMinutes), and how long before it the countdown is shown.
 */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const IDLE_WARNING_SECONDS = 120;

/** "1:45" for a countdown. */
function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Formal, complete-sentence message for a failed request. */
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? formalMessage(err.message) : fallback;
}

/** Formal notices shown on the sign-in screen. */
const PASSWORD_CHANGED_NOTICE = 'Your password has been changed. Please sign in again with your new password.';
const SESSION_ENDED_NOTICE = 'Your session has ended or was revoked. Please sign in again to continue.';
const SIGNED_OUT_NOTICE = 'You have been signed out.';
const idleSignedOutNotice = (minutes: number) => `You were signed out after ${minutes} minutes of inactivity.`;
const SESSION_REVOKED_HERE_NOTICE = 'You have been signed out of this device.';
const ALL_SESSIONS_NOTICE = 'All sessions on all devices have been signed out. Please sign in again.';

const DEFAULT_PAGE_SIZE = 50;

interface PageRequest {
  page: number;
  pageSize: number;
}

function offsetOf({ page, pageSize }: PageRequest): number {
  return (page - 1) * pageSize;
}

/** Legacy fallback: largest number of user pages fetched when the API cannot filter staff itself. */
const LEGACY_USER_SCAN_MAX_PAGES = 50;

/** "14:05": local time of a CMS save, for the draft confirmation. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function pageStateOf(request: PageRequest, total: number | null, count: number): PageState {
  return { page: request.page, pageSize: request.pageSize, total, count };
}

type PendingConfirm = { kind: 'logout-all' } | { kind: 'rollback'; versionNumber: number };

export default function AdminConsolePage() {
  // -------------------------------------------------------------
  // AUTHENTICATION & SESSION STATE
  // -------------------------------------------------------------
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  // False until GET /auth/me answers, so a signed-in user never sees the sign-in form flash
  const [hasCheckedSession, setHasCheckedSession] = useState(false);
  const [currentUser, setCurrentUser] = useState<StaffUser | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  // Formal informational notice on the sign-in screen (signed out, password changed, session ended)
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);

  // 2FA Challenge & Enrolment State
  const [requires2fa, setRequires2fa] = useState(false);
  const [isEnrolmentMode, setIsEnrolmentMode] = useState(false);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  // POST /auth/2fa/generate returns { secret, otpAuthUrl }; recovery codes come back from /auth/2fa/enable
  const [enrolmentData, setEnrolmentData] = useState<{ secret?: string; otpAuthUrl?: string } | null>(null);
  const [pendingRecoveryCodes, setPendingRecoveryCodes] = useState<string[] | null>(null);

  // Forced Password Change State
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');

  // Idle inactivity timeout (server-enforced; default 30 minutes)
  const lastActivityRef = useRef<number>(Date.now());
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(DEFAULT_IDLE_TIMEOUT_MINUTES);
  const idleMinutesRef = useRef(DEFAULT_IDLE_TIMEOUT_MINUTES);
  idleMinutesRef.current = idleTimeoutMinutes;
  const [idleWarning, setIdleWarning] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState(IDLE_WARNING_SECONDS);

  // Navigation Tab
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  // Off-canvas navigation drawer below 1024 px
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  // Confirmation dialogue (replaces window.confirm)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  // Inline error / notice banner (replaces alert())
  const [actionError, setActionErrorState] = useState<string | null>(null);
  // Set once the API reports the session as revoked/expired: late failures from in-flight requests are not shown
  const sessionEndedRef = useRef(false);
  const setActionError = useCallback((message: string | null) => {
    if (message !== null && sessionEndedRef.current) return;
    setActionErrorState(message);
  }, []);

  // -------------------------------------------------------------
  // TAB-SPECIFIC DATA STATES (WIRED TO REAL BACKEND API)
  // -------------------------------------------------------------
  // 1. Overview Checklist & Prize Summary
  const [checklist, setChecklist] = useState<Checklist>({
    canGoLive: false,
    items: []
  });
  const [prizePool, setPrizePool] = useState<PrizePool | null>(null);
  const [isLoadingOverview, setIsLoadingOverview] = useState(false);

  // 2. Hero Background / CMS
  const [heroConfig, setHeroConfig] = useState<HeroConfig>(DEFAULT_HERO_CONFIG);
  const [heroText, setHeroText] = useState<HeroText>(DEFAULT_HERO_TEXT);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [isLoadingCms, setIsLoadingCms] = useState(false);
  const [isSavingHero, setIsSavingHero] = useState(false);
  const [versionHistory, setVersionHistory] = useState<ContentVersion[]>([]);
  const [isUploadingHero, setIsUploadingHero] = useState(false);
  const [cmsSuccessMessage, setCmsSuccessMessage] = useState<string | null>(null);
  const [cmsErrorMessage, setCmsErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 3. Registrations Admissions Queue
  const [registrations, setRegistrations] = useState<AdminRegistration[]>([]);
  const [isLoadingRegistrations, setIsLoadingRegistrations] = useState(false);
  const [regPage, setRegPage] = useState<PageRequest>({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [regTotal, setRegTotal] = useState<number | null>(null);
  const [regStatusFilter, setRegStatusFilter] = useState('');
  // Team selector for technical inspection: registrations awaiting inspection, independent of the list paging
  const [inspectionRegistrations, setInspectionRegistrations] = useState<AdminRegistration[]>([]);

  // 4. Scrutineering Inspections
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [isLoadingInspections, setIsLoadingInspections] = useState(false);
  const [isSubmittingInspection, setIsSubmittingInspection] = useState(false);
  const [inspRegistrationId, setInspRegistrationId] = useState('');
  const [inspDiameter, setInspDiameter] = useState(200);
  const [inspWeight, setInspWeight] = useState(105);
  const [inspLatency, setInspLatency] = useState(0.12);
  const [inspNotes, setInspNotes] = useState('');
  const [inspResult, setInspResult] = useState<{ passed: boolean; message: string } | null>(null);

  // 5. Referee Scorer
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [isLoadingFixtures, setIsLoadingFixtures] = useState(false);
  const [isRecordingScore, setIsRecordingScore] = useState(false);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string>('');
  const selectedFixtureIdRef = useRef('');
  selectedFixtureIdRef.current = selectedFixtureId;
  const [activeFixture, setActiveFixture] = useState<Fixture | null>(null);

  // 6. Audit Logs
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [isExportingAudit, setIsExportingAudit] = useState(false);
  const [auditFilterAction, setAuditFilterAction] = useState('');
  const [auditFilterRole, setAuditFilterRole] = useState('');
  const [isLoadingAudit, setIsLoadingAudit] = useState(false);
  const [auditPage, setAuditPage] = useState<PageRequest>({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [auditTotal, setAuditTotal] = useState<number | null>(null);

  // 7. Users & Staff
  const [userList, setUserList] = useState<StaffUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersPage, setUsersPage] = useState<PageRequest>({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const [usersTotal, setUsersTotal] = useState<number | null>(null);
  const [usersPageCount, setUsersPageCount] = useState(0);
  const [createdStaff, setCreatedStaff] = useState<CreatedStaff | null>(null);
  const [isCreatingStaff, setIsCreatingStaff] = useState(false);
  const [createStaffError, setCreateStaffError] = useState<string | null>(null);
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffRole, setNewStaffRole] = useState('EVENT_ADMIN');

  // -------------------------------------------------------------
  // IDLE TIMEOUT MONITOR (SERVER-ENFORCED INACTIVITY LOGOUT)
  // -------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated) return;

    // Start the idle clock fresh whenever a session becomes active, and read the server's idle limit
    lastActivityRef.current = Date.now();
    adminFetch<{ session?: { idleTimeoutMinutes?: number } }>('/auth/me')
      .then((data) => {
        const minutes = Number(data?.session?.idleTimeoutMinutes);
        if (Number.isFinite(minutes) && minutes > 0) setIdleTimeoutMinutes(minutes);
      })
      .catch(() => undefined);

    const updateActivity = () => {
      lastActivityRef.current = Date.now();
      // Tells the API the user is active (at most once a minute), so the server-side idle clock follows
      noteUserActivity();
      setIdleWarning((prev) => (prev ? false : prev));
    };

    window.addEventListener('mousemove', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('click', updateActivity);
    window.addEventListener('scroll', updateActivity);

    // Checked every second so the warning shows a live countdown for the last two minutes
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      const limitMs = idleMinutesRef.current * 60 * 1000;
      if (elapsed > limitMs) {
        void logoutRef.current(idleSignedOutNotice(idleMinutesRef.current));
      } else if (elapsed > limitMs - IDLE_WARNING_SECONDS * 1000) {
        setIdleWarning(true);
        setIdleSecondsLeft((limitMs - elapsed) / 1000);
      }
    }, 1000);

    return () => {
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('click', updateActivity);
      window.removeEventListener('scroll', updateActivity);
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  // -------------------------------------------------------------
  // CHECK AUTHENTICATION STATUS ON MOUNT
  // -------------------------------------------------------------
  useEffect(() => {
    adminFetch<{ user?: StaffUser }>('/auth/me')
      .then((data) => {
        // A public (team captain) session can be present on the same host; it is not a console session
        if (data?.user && isStaffRole(data.user.role)) {
          setCurrentUser(data.user);
          setIsAuthenticated(true);
          // Server-side flag: an existing session must still complete the forced password change
          if (data.user.mustChangePassword) setMustChangePassword(true);
        }
      })
      .catch((err: unknown) => {
        setIsAuthenticated(false);
        // The server ended the session for inactivity while the console was closed
        if ((err as { code?: string } | null)?.code === SESSION_IDLE_TIMEOUT_CODE && err instanceof Error) setAuthNotice(err.message);
      })
      .finally(() => setHasCheckedSession(true));
  }, []);

  // -------------------------------------------------------------
  // REAL AUTH FLOW HANDLERS
  // -------------------------------------------------------------
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    setIsLoadingAuth(true);

    try {
      const res = await adminFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });

      if (res.requires2fa) {
        setChallengeToken(res.challengeToken);
        setRequires2fa(true);
        setTwoFactorCode('');
        setLoginPassword('');

        if (res.mustEnroll2fa) {
          setIsEnrolmentMode(true);
          // Fetch the TOTP setup key ({ secret, otpAuthUrl }); recovery codes are returned by /auth/2fa/enable
          const enrol = await adminFetch('/auth/2fa/generate', {
            method: 'POST',
            body: JSON.stringify({ challengeToken: res.challengeToken })
          });
          setEnrolmentData(enrol);
        } else {
          setIsEnrolmentMode(false);
        }
      } else if (res.user) {
        if (!isStaffRole(res.user.role)) {
          // Participant accounts sign in on the public site, not the staff console
          await adminFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
          setAuthError('This account does not have access to the staff console. Team captains sign in on the public site.');
          return;
        }
        setLoginPassword('');
        sessionEndedRef.current = false;
        setCurrentUser(res.user);
        setIsAuthenticated(true);
        if (res.mustChangePassword) {
          setMustChangePassword(true);
        }
      }
    } catch (err: unknown) {
      setAuthError(errorMessage(err, 'Sign-in failed. Please check your credentials and try again.'));
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const handleVerify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsLoadingAuth(true);

    try {
      if (isEnrolmentMode) {
        // Enrol new 2FA authenticator
        const res = await adminFetch('/auth/2fa/enable', {
          method: 'POST',
          body: JSON.stringify({
            challengeToken,
            code: twoFactorCode
          })
        });
        sessionEndedRef.current = false;
        setCurrentUser(res.user ?? null);
        setRequires2fa(false);
        setIsEnrolmentMode(false);
        setEnrolmentData(null);
        setChallengeToken(null);
        setTwoFactorCode('');
        if (res.mustChangePassword) {
          setMustChangePassword(true);
        }
        if (Array.isArray(res.recoveryCodes) && res.recoveryCodes.length > 0) {
          // Shown once on a dedicated screen; the console opens after the user confirms they saved them
          setPendingRecoveryCodes(res.recoveryCodes);
        }
        setIsAuthenticated(true);
      } else {
        // Verify existing 2FA code
        const res = await adminFetch('/auth/2fa/verify-login', {
          method: 'POST',
          body: JSON.stringify({
            challengeToken,
            code: twoFactorCode
          })
        });
        sessionEndedRef.current = false;
        setCurrentUser(res.user);
        setIsAuthenticated(true);
        setRequires2fa(false);
        setChallengeToken(null);
        setTwoFactorCode('');
        if (res.mustChangePassword) {
          setMustChangePassword(true);
        }
      }
    } catch (err: unknown) {
      setTwoFactorCode('');
      setAuthError(errorMessage(err, 'The authentication code is not valid. Please try again.'));
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const handleForcePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (newPasswordInput !== confirmPasswordInput) {
      setAuthError('The new passwords do not match.');
      return;
    }

    // Local part of the password policy; the API also checks breached passwords (400 WEAK_PASSWORD).
    const policyError = passwordPolicyError(newPasswordInput, currentUser?.email);
    if (policyError) {
      setAuthError(policyError);
      return;
    }

    if (newPasswordInput === currentPasswordInput) {
      setAuthError('The new password must be different from the temporary password.');
      return;
    }

    setIsLoadingAuth(true);
    try {
      await adminFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: currentPasswordInput,
          newPassword: newPasswordInput
        })
      });
      // The API revokes every session after a password change and does not issue a new one,
      // so the console returns to the sign-in screen instead of using the revoked session.
      clearSessionState({ notice: PASSWORD_CHANGED_NOTICE });
    } catch (err: unknown) {
      setAuthError(errorMessage(err, 'The password could not be changed. Please try again.'));
    } finally {
      setIsLoadingAuth(false);
    }
  };

  /** Clears every piece of local auth and console state and shows the sign-in screen. */
  const clearSessionState = ({ notice, error }: { notice?: string | null; error?: string | null } = {}) => {
    setIsAuthenticated(false);
    setCurrentUser(null);
    setRequires2fa(false);
    setIsEnrolmentMode(false);
    setEnrolmentData(null);
    setPendingRecoveryCodes(null);
    setMustChangePassword(false);
    setCurrentPasswordInput('');
    setNewPasswordInput('');
    setConfirmPasswordInput('');
    setChallengeToken(null);
    setTwoFactorCode('');
    setLoginPassword('');
    setIdleWarning(false);
    setPendingConfirm(null);
    setActionErrorState(null);
    setCreatedStaff(null);
    setCreateStaffError(null);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    setInspResult(null);
    setRegistrations([]);
    setInspectionRegistrations([]);
    setInspections([]);
    setAuditLogs([]);
    setUserList([]);
    setFixtures([]);
    setActiveFixture(null);
    setSelectedFixtureId('');
    setActiveTab('overview');
    setNavOpen(false);
    setAuthError(error ?? null);
    setAuthNotice(notice ?? null);
  };

  const handleLogout = async (reason?: string) => {
    try {
      await adminFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Server unreachable: cookies expire on their own; local state is cleared below
    }
    clearSessionState({ notice: reason ?? null });
  };

  // A revoked or expired session (401 after a failed refresh) returns the console to the sign-in screen
  const clearSessionRef = useRef(clearSessionState);
  clearSessionRef.current = clearSessionState;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  useEffect(() => {
    setSessionExpiredHandler((message, code) => {
      if (!isAuthenticatedRef.current || sessionEndedRef.current) return;
      sessionEndedRef.current = true;
      // Server-side idle timeout: say so, rather than the generic "session ended"
      const idle = code === SESSION_IDLE_TIMEOUT_CODE;
      clearSessionRef.current({ notice: idle ? message || idleSignedOutNotice(idleMinutesRef.current) : SESSION_ENDED_NOTICE });
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  // Always call the latest logout handler from long-lived timers
  const logoutRef = useRef(handleLogout);
  logoutRef.current = handleLogout;

  const handleLogoutAll = async () => {
    try {
      await adminFetch('/auth/logout-all', { method: 'POST' });
    } catch {
      // Fall through: local session state is cleared regardless
    }
    await handleLogout(ALL_SESSIONS_NOTICE);
  };

  // -------------------------------------------------------------
  // TAB DATA LOADERS (FETCH FROM REAL BACKEND)
  // -------------------------------------------------------------
  const loadOverviewData = useCallback(async () => {
    setIsLoadingOverview(true);
    try {
      const [checklistData, prizesData] = await Promise.all([
        adminFetch('/cms/admin/checklist'),
        adminFetch('/cms/prizes')
      ]);
      setChecklist(checklistData);
      setPrizePool(prizesData);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The overview could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingOverview(false);
    }
  }, [setActionError]);

  const loadCmsHeroData = useCallback(async () => {
    setIsLoadingCms(true);
    try {
      const rethrowSessionEnd = (err: unknown) => {
        if (isSessionExpiredError(err)) throw err;
        return null;
      };
      const [sections, section, versions] = await Promise.all([
        // Working copy (includes unpublished drafts); falls back to the published section below
        adminFetch<{ key?: string; data?: unknown }[]>('/cms/admin/sections').catch(rethrowSessionEnd),
        // 404 = hero section not created/published yet: start from defaults
        adminFetch('/cms/section/hero').catch(rethrowSessionEnd),
        adminFetch('/cms/admin/section/hero/versions').catch((err: unknown) => rethrowSessionEnd(err) ?? [])
      ]);
      const workingCopy = Array.isArray(sections) ? sections.find((item) => item?.key === 'hero') : undefined;
      const data = (workingCopy?.data as Record<string, unknown> | undefined) ?? section?.data;
      if (data && typeof data === 'object') {
        setHeroConfig(heroConfigFrom(data));
        setHeroText(heroTextFrom(data));
      }
      setVersionHistory(Array.isArray(versions) ? versions : []);
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setActionError(`The home page content could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoadingCms(false);
    }
  }, [setActionError]);

  const loadRegistrations = useCallback(async () => {
    setIsLoadingRegistrations(true);
    try {
      // The API pages with limit/offset (max 100 per request) and filters by status
      const params = new URLSearchParams({ limit: String(regPage.pageSize), offset: String(offsetOf(regPage)) });
      if (regStatusFilter) params.set('status', regStatusFilter);
      const data = await adminFetch('/registrations?' + params.toString());
      const { items, total } = toPagedResult<AdminRegistration>(data, 'registrations');
      setRegistrations(items);
      setRegTotal(total);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The registrations could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingRegistrations(false);
    }
  }, [regPage, regStatusFilter, setActionError]);

  /** Registrations the API accepts for inspection (status TECHNICAL_INSPECTION). */
  const loadInspectionRegistrations = useCallback(async () => {
    try {
      const data = await adminFetch('/registrations?status=TECHNICAL_INSPECTION&limit=100');
      const items = toPagedResult<AdminRegistration>(data, 'registrations').items;
      setInspectionRegistrations(items);
      setInspRegistrationId((current) => (items.some((r) => r.id === current) ? current : ''));
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The registrations awaiting inspection could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    }
  }, [setActionError]);

  const loadInspections = useCallback(async () => {
    setIsLoadingInspections(true);
    try {
      const data = await adminFetch('/inspections');
      setInspections(Array.isArray(data) ? data : []);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The inspection records could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingInspections(false);
    }
  }, [setActionError]);

  const loadFixtures = useCallback(async () => {
    setIsLoadingFixtures(true);
    try {
      const data = await adminFetch('/competition/fixtures');
      const fixtureList: Fixture[] = Array.isArray(data) ? data : [];
      setFixtures(fixtureList);
      // Keep the selected match (with fresh scores); otherwise select the first one
      const selected = fixtureList.find((f) => f.id === selectedFixtureIdRef.current) ?? fixtureList[0] ?? null;
      setSelectedFixtureId(selected?.id ?? '');
      setActiveFixture(selected);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The matches could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingFixtures(false);
    }
  }, [setActionError]);

  const loadAuditLogs = useCallback(async () => {
    setIsLoadingAudit(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(auditPage.pageSize));
      params.set('offset', String(offsetOf(auditPage)));
      if (auditFilterAction) params.set('action', auditFilterAction);
      if (auditFilterRole) params.set('actorRole', auditFilterRole);
      const data = await adminFetch(`/audit?${params.toString()}`);
      const { items, total } = toPagedResult<AuditLog>(data, 'logs');
      setAuditLogs(items);
      setAuditTotal(total);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The audit log could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingAudit(false);
    }
  }, [auditFilterAction, auditFilterRole, auditPage, setActionError]);

  /**
   * Fallback for an API without `scope=staff`: scan all user pages and keep staff roles only,
   * then page the staff list in the browser.
   */
  const loadStaffUsersLegacy = useCallback(async (request: PageRequest) => {
    const staff: StaffUser[] = [];
    let batch = toPagedResult<StaffUser>(await adminFetch('/auth/users')).items;
    let offset = 0;
    for (let scanned = 1; ; scanned += 1) {
      staff.push(...batch.filter((u) => isStaffRole(u.role)));
      if (batch.length < 100 || scanned >= LEGACY_USER_SCAN_MAX_PAGES) break;
      offset += batch.length;
      batch = toPagedResult<StaffUser>(await adminFetch(`/auth/users?limit=100&offset=${offset}`)).items;
    }
    const start = offsetOf(request);
    return { items: staff.slice(start, start + request.pageSize), total: staff.length };
  }, []);

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    try {
      let result: { items: StaffUser[]; total: number | null };
      try {
        const params = new URLSearchParams({
          scope: 'staff',
          withMeta: 'true',
          limit: String(usersPage.pageSize),
          offset: String(offsetOf(usersPage))
        });
        // Accepts both `{ items, total }` (withMeta) and a bare array
        result = toPagedResult<StaffUser>(await adminFetch(`/auth/users?${params.toString()}`));
      } catch (err) {
        if (isSessionExpiredError(err)) throw err;
        // Older API rejects the unknown `scope` parameter (400): filter staff in the browser instead
        result = await loadStaffUsersLegacy(usersPage);
      }
      // Team captains never appear here, even if the server returns them
      const staffOnly = result.items.filter((u) => isStaffRole(u.role));
      setUserList(staffOnly);
      setUsersPageCount(result.items.length);
      setUsersTotal(result.total);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The staff accounts could not be loaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsLoadingUsers(false);
    }
  }, [usersPage, loadStaffUsersLegacy, setActionError]);

  // Trigger tab data load on tab change
  // No dashboard data is requested until the forced password change is complete:
  // the API rejects every other request from a session with a temporary password.
  const canLoadData = isAuthenticated && !mustChangePassword;
  useEffect(() => {
    if (!canLoadData) return;
    // Tabs the role cannot open are not loaded (the navigation moves to a permitted tab)
    if (!canOpenTab(activeTab, currentUser?.role)) return;
    if (activeTab === 'overview') loadOverviewData();
    if (activeTab === 'cms_hero') loadCmsHeroData();
    if (activeTab === 'scoring') loadFixtures();
    if (activeTab === 'prizes') loadOverviewData();
    if (activeTab === 'scrutineering') {
      loadInspections();
      loadInspectionRegistrations();
    }
  }, [canLoadData, activeTab, currentUser?.role, loadOverviewData, loadCmsHeroData, loadInspections, loadInspectionRegistrations, loadFixtures]);

  // Roles see only the sections their permissions allow; an unavailable tab moves to the first permitted one
  const visibleNavItems = NAV_ITEMS.filter((item) => canOpenTab(item.id, currentUser?.role));
  useEffect(() => {
    if (!currentUser?.role || canOpenTab(activeTab, currentUser.role)) return;
    const first = NAV_ITEMS.find((item) => canOpenTab(item.id, currentUser.role));
    if (first) setActiveTab(first.id);
  }, [activeTab, currentUser?.role]);

  // Paged lists reload when their page, page size or filters change
  useEffect(() => {
    if (canLoadData && activeTab === 'registrations') loadRegistrations();
  }, [canLoadData, activeTab, loadRegistrations]);
  useEffect(() => {
    if (canLoadData && activeTab === 'audit') loadAuditLogs();
  }, [canLoadData, activeTab, loadAuditLogs]);
  useEffect(() => {
    if (canLoadData && activeTab === 'users') loadUsers();
  }, [canLoadData, activeTab, loadUsers]);

  // -------------------------------------------------------------
  // TAB ACTION HANDLERS
  // -------------------------------------------------------------
  // Hero Draft, Publish & Rollback
  /**
   * Saves the working copy. Background settings and hero text are stored together at the top level
   * of `data`, which is where the public site reads them (d.headline, d.description, d.announcement*).
   */
  const saveHeroDraft = async () => {
    const text = Object.fromEntries(
      Object.entries(heroText).map(([key, value]) => [key, value.trim()])
    ) as unknown as HeroText;
    await adminFetch('/cms/admin/section/hero/draft', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Landing Page Hero',
        data: { ...heroConfig, ...text }
      })
    });
  };

  const handleSaveHeroDraft = async () => {
    setIsSavingHero(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      await saveHeroDraft();
      setCmsSuccessMessage(`Draft saved at ${formatTime(new Date())}. The public site is unchanged until you publish.`);
      loadCmsHeroData();
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setCmsErrorMessage(`The draft could not be saved. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsSavingHero(false);
    }
  };

  const handlePublishHero = async () => {
    setIsSavingHero(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      // Publishing snapshots the working copy, so the current edits are saved as the draft first
      await saveHeroDraft();
      await adminFetch('/cms/admin/section/hero/publish', {
        method: 'POST',
        body: JSON.stringify({
          changeNote: `Published from the staff console by ${currentUser?.email ?? 'a staff member'}`
        })
      });
      setCmsSuccessMessage('Published. The public site now shows this version.');
      loadCmsHeroData();
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setCmsErrorMessage(`The content could not be published. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsSavingHero(false);
    }
  };

  const handleRollbackHero = (versionNum: number) => {
    setPendingConfirm({ kind: 'rollback', versionNumber: versionNum });
  };

  const rollbackHero = async (versionNum: number) => {
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      await adminFetch(`/cms/admin/section/hero/rollback/${versionNum}`, {
        method: 'POST'
      });
      setCmsSuccessMessage(`Version ${versionNum} has been restored and published as a new version.`);
      loadCmsHeroData();
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setCmsErrorMessage(`Version ${versionNum} could not be restored. ${errorMessage(err, 'Please try again.')}`);
      }
    }
  };

  const handleUploadHeroBackground = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Checked here as well as by the API, so an unsuitable file is reported before it is sent
    const problem =
      heroConfig.mediaType === 'video'
        ? file.type !== 'video/mp4'
          ? `${file.name} is not an MP4 video. Please choose an MP4 file.`
          : file.size > UPLOAD_LIMITS.CMS_BACKGROUND
            ? `${file.name} is larger than the permitted ${formatBytes(UPLOAD_LIMITS.CMS_BACKGROUND)}.`
            : null
        : validateImageFile(file, 'CMS_BACKGROUND');
    if (problem) {
      setCmsSuccessMessage(null);
      setCmsErrorMessage(problem);
      e.target.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('purpose', 'CMS_BACKGROUND');

    setIsUploadingHero(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      const data = await adminFetch<{ fileUrl: string }>('/uploads/stream', {
        method: 'POST',
        body: formData
      });
      setHeroConfig((prev) => ({ ...prev, mediaUrl: data.fileUrl }));
      setCmsSuccessMessage('The background file has been uploaded, scanned for malware and stripped of metadata. Save or publish to apply it.');
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setCmsErrorMessage(`The file could not be uploaded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsUploadingHero(false);
      // Allow selecting the same file again
      e.target.value = '';
    }
  };

  // Registration Status Transition (the API expects `targetStatus`; the reason is kept in the audit log)
  const handleUpdateRegistrationStatus = async (regId: string, targetStatus: string, reason?: string) => {
    try {
      await adminFetch(`/registrations/${regId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(reason ? { targetStatus, reason } : { targetStatus })
      });
    } catch (err: unknown) {
      throw new Error(errorMessage(err, 'The status could not be changed. Please try again.'));
    }
    loadRegistrations();
    notifyRegistrationsChanged();
  };

  // Scrutineering Submission
  const handleSubmitScrutineering = async (e: React.FormEvent) => {
    e.preventDefault();
    setInspResult(null);
    const registration = inspectionRegistrations.find((r) => r.id === inspRegistrationId);
    if (!registration) {
      setInspResult({ passed: false, message: 'Please select a registration that is awaiting technical inspection.' });
      return;
    }
    if (![inspDiameter, inspWeight, inspLatency].every((value) => Number.isFinite(value) && value >= 0)) {
      setInspResult({ passed: false, message: 'Please enter every measurement as a number of zero or more.' });
      return;
    }

    const inspLimits = FIDA_BALL_LIMITS[fidaClassOf(registration.category?.name)];
    const diameterPassed = inspDiameter >= inspLimits.minDiameterMm && inspDiameter <= inspLimits.maxDiameterMm;
    const weightPassed = inspWeight > 0 && inspWeight <= inspLimits.maxWeightGrams;
    const failsafePassed = inspLatency < FAILSAFE_MAX_SECONDS;
    const passed = diameterPassed && weightPassed && failsafePassed;
    const teamName = registration.team?.name || registration.registrationCode || 'The team';

    setIsSubmittingInspection(true);
    try {
      await adminFetch('/inspections', {
        method: 'POST',
        body: JSON.stringify({
          registrationId: inspRegistrationId,
          checks: {
            diameterMm: { value: inspDiameter, passed: diameterPassed },
            weightGrams: { value: inspWeight, passed: weightPassed },
            killSwitchLatencySeconds: { value: inspLatency, passed: failsafePassed }
          },
          notes: inspNotes.trim() || `Technical inspection against the FIDA ${inspLimits.label} drone ball specifications`,
          passed
        })
      });
      const failed = [
        !diameterPassed && 'diameter',
        !weightPassed && 'weight',
        !failsafePassed && 'failsafe response'
      ].filter(Boolean);
      setInspResult(
        passed
          ? { passed, message: `Passed. ${teamName} meets the ${inspLimits.label} inspection requirements; the registration has moved to Eligibility Review.` }
          : {
              passed,
              message: `Failed (${failed.join(', ')}). ${teamName} does not meet the ${inspLimits.label} inspection requirements; the registration has moved to Requires Action.`
            }
      );
      setInspNotes('');
      loadInspections();
      loadInspectionRegistrations();
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setInspResult({ passed: false, message: `The inspection could not be recorded. ${errorMessage(err, 'Please try again.')}` });
      }
    } finally {
      setIsSubmittingInspection(false);
    }
  };

  // Live Score Event Recording
  const handleRecordScoreEvent = async (teamId: string, eventType: string, scoreDelta = 1) => {
    if (!activeFixture || !teamId) return;
    setIsRecordingScore(true);
    try {
      const updated = await adminFetch(`/competition/fixtures/${activeFixture.id}/event`, {
        method: 'POST',
        body: JSON.stringify({
          teamId,
          eventType,
          scoreDelta
        })
      });
      setActiveFixture(updated);
      setFixtures((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The goal could not be recorded. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsRecordingScore(false);
    }
  };

  const handleChangeMatchStatus = async (targetStatus: string) => {
    if (!activeFixture) return;
    try {
      const updated = await adminFetch(`/competition/fixtures/${activeFixture.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ targetStatus })
      });
      setActiveFixture(updated);
      setFixtures((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
    } catch (err: unknown) {
      throw new Error(errorMessage(err, `The match could not be moved to ${statusLabel(targetStatus)}.`));
    }
  };

  // Prize update (amount, title, confirmation, notes)
  const handleSavePrize = async (id: string, update: PrizeUpdate) => {
    try {
      await adminFetch(`/cms/admin/prize/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(update)
      });
    } catch (err: unknown) {
      throw new Error(errorMessage(err, 'The prize could not be updated. Please try again.'));
    }
    loadOverviewData();
  };

  // Staff User Creation
  const handleCreateStaffUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateStaffError(null);
    setCreatedStaff(null);
    setIsCreatingStaff(true);
    try {
      const created: { user?: StaffUser; tempPassword?: string } = await adminFetch('/auth/staff-user', {
        method: 'POST',
        body: JSON.stringify({
          email: newStaffEmail.trim(),
          fullName: newStaffName.trim(),
          role: newStaffRole
        })
      });
      // The API returns the one-time temporary password exactly once: show it inline so it can be handed over
      setCreatedStaff({ email: created?.user?.email || newStaffEmail, tempPassword: created?.tempPassword });
      setNewStaffEmail('');
      setNewStaffName('');
      loadUsers();
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setCreateStaffError(`The staff account could not be created. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsCreatingStaff(false);
    }
  };

  // Audit CSV export with inline error reporting
  const handleExportAuditCsv = async () => {
    setIsExportingAudit(true);
    try {
      const params: Record<string, string> = {};
      if (auditFilterAction) params.action = auditFilterAction;
      if (auditFilterRole) params.actorRole = auditFilterRole;
      await downloadAuditCsv(params);
    } catch (err: unknown) {
      if (!isSessionExpiredError(err)) {
        setActionError(`The audit log could not be exported. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsExportingAudit(false);
    }
  };

  const runPendingConfirm = async () => {
    if (!pendingConfirm) return;
    setIsConfirming(true);
    try {
      if (pendingConfirm.kind === 'logout-all') {
        await handleLogoutAll();
      } else {
        await rollbackHero(pendingConfirm.versionNumber);
      }
    } finally {
      setIsConfirming(false);
      setPendingConfirm(null);
    }
  };

  // -------------------------------------------------------------
  // VIEW: 0. SESSION CHECK (AVOIDS A FLASH OF THE SIGN-IN FORM)
  // -------------------------------------------------------------
  if (!hasCheckedSession) {
    return (
      <div className="min-h-screen bg-[#0B0F19] flex items-center justify-center" role="status">
        <span className="sr-only">Checking the session.</span>
        <div className="w-8 h-8 rounded-full border-2 border-slate-700 border-t-[#22C55E] animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: 1. ONE-TIME RECOVERY CODES (AFTER 2FA ENROLMENT)
  // -------------------------------------------------------------
  if (isAuthenticated && pendingRecoveryCodes) {
    return <RecoveryCodesScreen codes={pendingRecoveryCodes} onContinue={() => setPendingRecoveryCodes(null)} />;
  }

  // -------------------------------------------------------------
  // VIEW: 2. FORCED PASSWORD CHANGE SCREEN
  // -------------------------------------------------------------
  if (isAuthenticated && mustChangePassword) {
    return (
      <PasswordChangeScreen
        email={currentUser?.email}
        authError={authError}
        isLoading={isLoadingAuth}
        currentPassword={currentPasswordInput}
        setCurrentPassword={setCurrentPasswordInput}
        newPassword={newPasswordInput}
        setNewPassword={setNewPasswordInput}
        confirmPassword={confirmPasswordInput}
        setConfirmPassword={setConfirmPasswordInput}
        onSubmit={handleForcePasswordChange}
      />
    );
  }

  // -------------------------------------------------------------
  // VIEW: 3. REAL AUTHENTICATION & 2FA LOGIN SCREEN
  // -------------------------------------------------------------
  if (!isAuthenticated) {
    return (
      <LoginScreen
        authError={authError}
        authNotice={authNotice}
        isLoading={isLoadingAuth}
        requires2fa={requires2fa}
        isEnrolmentMode={isEnrolmentMode}
        enrolmentData={enrolmentData}
        loginEmail={loginEmail}
        setLoginEmail={setLoginEmail}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        twoFactorCode={twoFactorCode}
        setTwoFactorCode={setTwoFactorCode}
        onLogin={handleLogin}
        onVerify2fa={handleVerify2fa}
        onBackToLogin={() => {
          setRequires2fa(false);
          setIsEnrolmentMode(false);
          setEnrolmentData(null);
          setChallengeToken(null);
          setTwoFactorCode('');
          setAuthError(null);
        }}
      />
    );
  }

  const activeTitle = NAV_ITEMS.find((item) => item.id === activeTab)?.title ?? '';
  // Menu items the role may open, with their count badges, grouped under Event, Website and Administration
  const sidebarItems = visibleNavItems.map((item) => ({
    ...item,
    badge: (isActive: boolean) => {
      const id = item.id;
      return (
        <>
          {id === 'registrations' && <AwaitingReviewBadge role={currentUser?.role} active={isActive} />}
          {id === 'registrations' && <PendingVerificationBadge role={currentUser?.role} active={isActive} />}
        </>
      );
    }
  }));
  const sidebarGroups: SidebarGroup<AdminTab>[] = NAV_GROUPS.map((group) => ({
    ...group,
    items: sidebarItems.filter((item) => item.group === group.id)
  })).filter((group) => group.items.length > 0);
  const canManageContent = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'EVENT_ADMIN';

  // -------------------------------------------------------------
  // VIEW: 4. AUTHENTICATED STAFF WORKSPACE
  // -------------------------------------------------------------
  return (
    <MotionProvider>
      <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex">
        {/* 1. LEFT SIDEBAR: grouped sections; collapsible icon rail from 1024 px, off-canvas drawer below */}
        <AdminSidebar
          groups={sidebarGroups}
          activeId={activeTab}
          onSelect={(id) => {
            setActionError(null);
            setActiveTab(id);
          }}
          user={{
            name: currentUser?.fullName?.trim() || currentUser?.email || 'Staff member',
            email: currentUser?.email ?? '',
            role: roleLabel(currentUser?.role)
          }}
          onSignOut={() => handleLogout(SIGNED_OUT_NOTICE)}
          onSignOutAll={() => setPendingConfirm({ kind: 'logout-all' })}
          mobileOpen={navOpen}
          onMobileClose={closeNav}
        />

        {/* 2. MAIN WORKSPACE */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="px-4 md:px-8 py-5 border-b border-slate-800 bg-[#111625]/90 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
                aria-expanded={navOpen}
                aria-controls="admin-nav-drawer"
                className="lg:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-slate-950 bg-bento-lime text-slate-950 shadow-[3px_3px_0_#000] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
            <div className="min-w-0">
              <div className="text-[10px] font-bold text-[#22C55E] uppercase tracking-widest font-mono">Staff Console</div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.h1
                  key={activeTitle}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.22 } }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  className="text-lg md:text-xl font-black text-white truncate"
                >
                  {activeTitle}
                </motion.h1>
              </AnimatePresence>
            </div>
            </div>

            <div className="flex items-center gap-3 min-w-0">
              <span className="px-3 py-1 rounded-full bg-[#22C55E]/15 text-[#22C55E] border border-[#22C55E]/30 text-xs font-mono font-bold whitespace-nowrap">
                {roleLabel(currentUser?.role)}
              </span>
              <span className="hidden md:inline text-xs text-slate-400 font-mono truncate">{currentUser?.email}</span>
            </div>
          </header>

          <main className="p-4 md:p-8 space-y-6 flex-1">
            <Notice tone="error" message={actionError} onDismiss={() => setActionError(null)} />

            <AnimatePresence mode="wait" initial={false}>
              <TabPanel key={activeTab} panelKey={activeTab}>
                {activeTab === 'overview' && <OverviewTab checklist={checklist} prizePool={prizePool} isLoading={isLoadingOverview} />}

                {activeTab === 'cms_hero' && (
                  <CmsHeroTab
                    heroConfig={heroConfig}
                    setHeroConfig={setHeroConfig}
                    heroText={heroText}
                    setHeroText={setHeroText}
                    previewDevice={previewDevice}
                    setPreviewDevice={setPreviewDevice}
                    isLoading={isLoadingCms}
                    isSavingHero={isSavingHero}
                    isUploading={isUploadingHero}
                    versionHistory={versionHistory}
                    cmsSuccessMessage={cmsSuccessMessage}
                    cmsErrorMessage={cmsErrorMessage}
                    onDismissMessages={() => {
                      setCmsSuccessMessage(null);
                      setCmsErrorMessage(null);
                    }}
                    fileInputRef={fileInputRef}
                    handleUploadHeroBackground={handleUploadHeroBackground}
                    handleSaveHeroDraft={handleSaveHeroDraft}
                    handlePublishHero={handlePublishHero}
                    handleRollbackHero={handleRollbackHero}
                    onOpenSiteInfo={() => setActiveTab('site_info')}
                  />
                )}

                {activeTab === 'registrations' && (
                  <RegistrationsTab
                    registrations={registrations}
                    isLoadingRegistrations={isLoadingRegistrations}
                    loadRegistrations={loadRegistrations}
                    handleUpdateRegistrationStatus={handleUpdateRegistrationStatus}
                    pageState={pageStateOf(regPage, regTotal, registrations.length)}
                    onPageChange={(page) => setRegPage((prev) => ({ ...prev, page }))}
                    onPageSizeChange={(pageSize) => setRegPage({ page: 1, pageSize })}
                    statusFilter={regStatusFilter}
                    role={currentUser?.role}
                    onStatusFilterChange={(status) => {
                setRegStatusFilter(status);
                setRegPage((prev) => ({ ...prev, page: 1 }));
                    }}
                  />
                )}

                {activeTab === 'scrutineering' && (
                  <ScrutineeringTab
                    registrations={inspectionRegistrations}
                    inspections={inspections}
                    isLoadingInspections={isLoadingInspections}
                    inspResult={inspResult}
                    onDismissResult={() => setInspResult(null)}
                    inspRegistrationId={inspRegistrationId}
                    setInspRegistrationId={setInspRegistrationId}
                    inspDiameter={inspDiameter}
                    setInspDiameter={setInspDiameter}
                    inspWeight={inspWeight}
                    setInspWeight={setInspWeight}
                    inspLatency={inspLatency}
                    setInspLatency={setInspLatency}
                    inspNotes={inspNotes}
                    setInspNotes={setInspNotes}
                    isSubmitting={isSubmittingInspection}
                    handleSubmitScrutineering={handleSubmitScrutineering}
                    role={currentUser?.role}
                  />
                )}

                {activeTab === 'scoring' && (
                  <ScoringTab
                    fixtures={fixtures}
                    isLoadingFixtures={isLoadingFixtures}
                    selectedFixtureId={selectedFixtureId}
                    onSelectFixture={(id) => {
                      setSelectedFixtureId(id);
                      setActiveFixture(fixtures.find((f) => f.id === id) ?? null);
                    }}
                    activeFixture={activeFixture}
                    onRefresh={loadFixtures}
                    isRecording={isRecordingScore}
                    handleRecordScoreEvent={handleRecordScoreEvent}
                    handleChangeMatchStatus={handleChangeMatchStatus}
                  />
                )}

                {activeTab === 'audit' && (
                  <AuditTab
                    auditLogs={auditLogs}
                    isLoadingAudit={isLoadingAudit}
                    auditFilterAction={auditFilterAction}
                    setAuditFilterAction={(value) => {
                setAuditFilterAction(value);
                setAuditPage((prev) => ({ ...prev, page: 1 }));
                    }}
                    auditFilterRole={auditFilterRole}
                    setAuditFilterRole={(value) => {
                      setAuditFilterRole(value);
                      setAuditPage((prev) => ({ ...prev, page: 1 }));
                    }}
                    loadAuditLogs={loadAuditLogs}
                    onExportCsv={handleExportAuditCsv}
                    isExporting={isExportingAudit}
                    pageState={pageStateOf(auditPage, auditTotal, auditLogs.length)}
                    onPageChange={(page) => setAuditPage((prev) => ({ ...prev, page }))}
                    onPageSizeChange={(pageSize) => setAuditPage({ page: 1, pageSize })}
                  />
                )}

                {activeTab === 'users' && (
                  <UsersTab
                    userList={userList}
                    currentUserRole={currentUser?.role}
                    currentUserId={currentUser?.id}
                    onUserUpdated={(updated) =>
                      setUserList((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)))
                    }
                    newStaffName={newStaffName}
                    setNewStaffName={setNewStaffName}
                    newStaffEmail={newStaffEmail}
                    setNewStaffEmail={setNewStaffEmail}
                    newStaffRole={newStaffRole}
                    setNewStaffRole={setNewStaffRole}
                    handleCreateStaffUser={handleCreateStaffUser}
                    isCreatingStaff={isCreatingStaff}
                    createError={createStaffError}
                    onDismissCreateError={() => setCreateStaffError(null)}
                    createdStaff={createdStaff}
                    onDismissCreatedStaff={() => setCreatedStaff(null)}
                    isLoadingUsers={isLoadingUsers}
                    pageState={pageStateOf(usersPage, usersTotal, usersPageCount)}
                    onPageChange={(page) => setUsersPage((prev) => ({ ...prev, page }))}
                    onPageSizeChange={(pageSize) => setUsersPage({ page: 1, pageSize })}
                  />
                )}

                {activeTab === 'home_sections' && <HomeSectionsTab role={currentUser?.role} />}

                {activeTab === 'site_info' && <SiteInfoTab role={currentUser?.role} />}

                {activeTab === 'sponsors' && <SponsorsTab role={currentUser?.role} />}

                {activeTab === 'gallery' && <GalleryTab role={currentUser?.role} />}

                {activeTab === 'championship_media' && <ChampionshipMediaTab role={currentUser?.role} />}

                {activeTab === 'security' && (
                  <SecurityTab
                    currentUser={currentUser}
                    idleTimeoutMinutes={idleTimeoutMinutes}
                    onSignOutAll={() => setPendingConfirm({ kind: 'logout-all' })}
                    onPasswordChanged={() => clearSessionState({ notice: PASSWORD_CHANGED_NOTICE })}
                    onCurrentSessionRevoked={() => clearSessionState({ notice: SESSION_REVOKED_HERE_NOTICE })}
                  />
                )}

                {activeTab === 'prizes' &&
                  (prizePool ? (
                    <PrizesTab prizePool={prizePool} canEdit={canManageContent} onSavePrize={handleSavePrize} />
                  ) : isLoadingOverview ? (
                    <TabLoading />
                  ) : (
                    <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
                      No prize information is available.
                    </div>
                  ))}
              </TabPanel>
            </AnimatePresence>
          </main>
        </div>

        <ConfirmDialog
          open={pendingConfirm !== null}
          title={pendingConfirm?.kind === 'rollback' ? 'Restore Published Version' : 'Sign Out of All Sessions'}
          message={
            pendingConfirm?.kind === 'rollback'
              ? `Restore version ${pendingConfirm.versionNumber} of the home page hero? It will be published immediately as a new version; unpublished edits in the working copy will be replaced.`
              : 'Sign out of every active session on all devices, including this one? You will need to sign in again.'
          }
          confirmLabel={pendingConfirm?.kind === 'rollback' ? 'Restore and Publish' : 'Sign Out Everywhere'}
          tone="danger"
          busy={isConfirming}
          onConfirm={runPendingConfirm}
          onCancel={() => setPendingConfirm(null)}
        />

        {/* Inactivity warning with a live countdown; any activity dismisses it */}
        <div role="alert" className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-6 z-40 flex justify-center pointer-events-none">
          <AnimatePresence>
            {idleWarning && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.25 } }}
                exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                className="pointer-events-auto w-full sm:w-[340px] p-4 bg-[#1a1608] border border-amber-500/50 text-amber-200 rounded-xl shadow-2xl shadow-black/50 flex items-start gap-3"
              >
                <Clock className="w-5 h-5 shrink-0 mt-0.5 text-amber-300" aria-hidden="true" />
                <div className="space-y-2 min-w-0">
                  <div className="text-xs font-bold text-amber-100">Session Ending Soon</div>
                  <p className="text-[11px] leading-relaxed">
                    No activity has been detected. You will be signed out in{' '}
                    <span className="font-mono font-bold text-white" aria-hidden="true">
                      {formatCountdown(idleSecondsLeft)}
                    </span>
                    <span className="sr-only">less than two minutes</span>.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      lastActivityRef.current = Date.now();
                      setIdleWarning(false);
                      // Resets the server-side idle clock too
                      void keepSessionAlive().catch(() => undefined);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-bold transition-colors"
                  >
                    Stay Signed In
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <StepUpDialog />
      </div>
    </MotionProvider>
  );
}
