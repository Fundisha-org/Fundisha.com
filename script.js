/**
 * ==========================================================================
 * FUNDISHA — Frontend Application Architecture (ES Module with Firebase)
 * Educational Resource Platform & Study Companion for Uganda Secondary Schools
 * ==========================================================================
 */

import { FundishaData, getLucideIconSvg } from './src/data.js';
import {
  auth,
  db
} from './src/firebase/config.js';
import {
  registerWithEmail,
  loginWithEmail,
  logout,
  resetPassword,
  subscribeToAuth,
  getCurrentUser
} from './src/firebase/authService.js';
import {
  getUserProfile,
  createUserProfile,
  updateUserProfile,
  updateUserGamification,
  getLeaderboard
} from './src/firebase/userService.js';
import {
  seedInitialResourcesIfEmpty,
  fetchResources,
  fetchResourceById,
  recordResourceInteraction,
  submitResourceReport
} from './src/firebase/resourceService.js';
import {
  getUserBookmarks,
  addBookmark,
  removeBookmark,
  syncLocalBookmarksToFirebase
} from './src/firebase/bookmarkService.js';
import {
  seedQuizzesIfEmpty,
  getQuizzesBySubject,
  recordQuizAttempt,
  getUserQuizHistory
} from './src/firebase/quizService.js';
import {
  getUserRecentlyViewed,
  addRecentlyViewed,
  logProgressEvent
} from './src/firebase/progressService.js';
import {
  migrateLocalDataToFirebase
} from './src/firebase/migrationService.js';

// --------------------------------------------------------------------------
// 1. Storage & Local Persistence Service (Fallback & Local Layer)
// --------------------------------------------------------------------------

const StorageService = {
  KEYS: {
    PROFILE: 'fundisha_user_profile',
    BOOKMARKS: 'fundisha_bookmarks',
    STREAK: 'fundisha_study_streak',
    POINTS: 'fundisha_study_points',
    QUIZ_HISTORY: 'fundisha_quiz_history',
    RECENTLY_VIEWED: 'fundisha_recent_resources',
    THEME: 'fundisha_theme_preference'
  },

  getProfile() {
    try {
      const data = localStorage.getItem(this.KEYS.PROFILE);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  },

  saveProfile(profile) {
    try {
      localStorage.setItem(this.KEYS.PROFILE, JSON.stringify(profile));
    } catch (e) {}
  },

  getBookmarks() {
    try {
      const data = localStorage.getItem(this.KEYS.BOOKMARKS);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  setBookmarks(bookmarks) {
    try {
      localStorage.setItem(this.KEYS.BOOKMARKS, JSON.stringify(bookmarks));
    } catch (e) {}
  },

  async toggleBookmark(resourceId) {
    let bookmarks = this.getBookmarks();
    let isSaved = false;

    if (bookmarks.includes(resourceId)) {
      bookmarks = bookmarks.filter(id => id !== resourceId);
      isSaved = false;
      if (AppState.currentUser) {
        await removeBookmark(AppState.currentUser.uid, resourceId);
      }
    } else {
      bookmarks.push(resourceId);
      isSaved = true;
      if (AppState.currentUser) {
        const res = FundishaData.RESOURCES.find(r => r.id === resourceId) || { id: resourceId };
        await addBookmark(AppState.currentUser.uid, res);
      }
    }

    this.setBookmarks(bookmarks);
    return { isSaved, total: bookmarks.length };
  },

  getStreak() {
    try {
      const data = localStorage.getItem(this.KEYS.STREAK);
      if (!data) return { count: 1, lastDate: new Date().toISOString().slice(0, 10) };
      return JSON.parse(data);
    } catch (e) {
      return { count: 1, lastDate: '' };
    }
  },

  updateStreak() {
    const today = new Date().toISOString().slice(0, 10);
    const streak = this.getStreak();

    if (streak.lastDate !== today) {
      streak.count += 1;
      streak.lastDate = today;
      try {
        localStorage.setItem(this.KEYS.STREAK, JSON.stringify(streak));
      } catch (e) {}
    }
    return streak.count;
  },

  getPoints() {
    try {
      const pts = localStorage.getItem(this.KEYS.POINTS);
      return pts ? parseInt(pts, 10) : 150;
    } catch (e) {
      return 150;
    }
  },

  async addPoints(amount) {
    const current = this.getPoints();
    const updated = current + amount;
    try {
      localStorage.setItem(this.KEYS.POINTS, updated.toString());
    } catch (e) {}

    if (AppState.currentUser) {
      const streak = this.getStreak().count;
      await updateUserGamification(AppState.currentUser.uid, updated, streak);
    }
    return updated;
  },

  getQuizHistory() {
    try {
      const data = localStorage.getItem(this.KEYS.QUIZ_HISTORY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  async saveQuizResult(result) {
    const history = this.getQuizHistory();
    history.unshift(result);
    this.addPoints(50);
    try {
      localStorage.setItem(this.KEYS.QUIZ_HISTORY, JSON.stringify(history.slice(0, 20)));
    } catch (e) {}

    if (AppState.currentUser) {
      await recordQuizAttempt(AppState.currentUser.uid, result);
    }
  },

  getRecentlyViewed() {
    try {
      const data = localStorage.getItem(this.KEYS.RECENTLY_VIEWED);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  async addRecentlyViewed(resourceId) {
    let list = this.getRecentlyViewed().filter(id => id !== resourceId);
    list.unshift(resourceId);
    try {
      localStorage.setItem(this.KEYS.RECENTLY_VIEWED, JSON.stringify(list.slice(0, 8)));
    } catch (e) {}

    if (AppState.currentUser) {
      const res = FundishaData.RESOURCES.find(r => r.id === resourceId) || { id: resourceId };
      await addRecentlyViewed(AppState.currentUser.uid, res);
    }
  },

  getTheme() {
    return localStorage.getItem(this.KEYS.THEME) || 'light';
  },

  setTheme(theme) {
    localStorage.setItem(this.KEYS.THEME, theme);
  },

  clearAllData() {
    localStorage.clear();
  }
};

// --------------------------------------------------------------------------
// 2. Application State Manager
// --------------------------------------------------------------------------

const AppState = {
  user: null,
  currentUser: null,
  isAuthLoaded: false,
  currentView: 'home',
  activeFilters: {
    class: 'All',
    subject: 'All',
    type: 'All',
    topic: 'All',
    search: '',
    sort: 'recommended'
  },
  selectedResourceId: null,
  selectedSubjectId: null,
  
  currentQuiz: {
    subject: 'Mathematics',
    questions: [],
    currentIndex: 0,
    userAnswers: [],
    isSubmitted: false
  },

  async init() {
    let profile = StorageService.getProfile();
    if (!profile) {
      profile = {
        name: 'Student',
        class: 'Senior 5',
        subjects: ['Mathematics', 'Physics', 'Chemistry', 'ICT'],
        isOnboarded: false
      };
      StorageService.saveProfile(profile);
    }
    this.user = profile;

    const theme = StorageService.getTheme();
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeIcons(theme);

    StorageService.updateStreak();

    // Initialize Firebase Background Seeding
    seedInitialResourcesIfEmpty(FundishaData.RESOURCES).catch(() => {});
    seedQuizzesIfEmpty(FundishaData.QUIZZES_DATA).catch(() => {});

    // Listen to Firebase Authentication State
    subscribeToAuth(async (firebaseUser) => {
      this.currentUser = firebaseUser;
      this.isAuthLoaded = true;

      if (firebaseUser) {
        // Fetch or create profile in Firestore
        let cloudProfile = await getUserProfile(firebaseUser.uid);
        if (!cloudProfile) {
          await createUserProfile(firebaseUser, {
            name: firebaseUser.displayName || this.user.name || 'Scholar',
            class: this.user.class || 'Senior 5',
            subjects: this.user.subjects || ['Mathematics', 'Physics']
          });
          cloudProfile = await getUserProfile(firebaseUser.uid);
        }

        // Merge cloud profile into local state
        if (cloudProfile) {
          this.user = {
            name: cloudProfile.name || this.user.name,
            class: cloudProfile.class || this.user.class,
            subjects: cloudProfile.subjects || this.user.subjects,
            points: cloudProfile.points || this.user.points || 150,
            streak: cloudProfile.streak || this.user.streak || 1,
            isOnboarded: true
          };
          StorageService.saveProfile(this.user);
        }

        // Migrate local data into Firestore
        await migrateLocalDataToFirebase(firebaseUser.uid);

        // Fetch cloud bookmarks to sync locally
        const cloudBookmarks = await getUserBookmarks(firebaseUser.uid);
        if (cloudBookmarks && cloudBookmarks.length > 0) {
          StorageService.setBookmarks(cloudBookmarks);
        }
      }

      this.updateAuthUI();
      UIController.updateHeaderBadges();
    });
  },

  updateThemeIcons(theme) {
    const moon = document.getElementById('theme-icon-moon');
    const sun = document.getElementById('theme-icon-sun');
    if (moon && sun) {
      if (theme === 'dark') {
        moon.style.display = 'none';
        sun.style.display = 'block';
      } else {
        moon.style.display = 'block';
        sun.style.display = 'none';
      }
    }
  },

  updateAuthUI() {
    const badge = document.getElementById('header-auth-badge');
    const guestSection = document.getElementById('settings-auth-guest-section');
    const userSection = document.getElementById('settings-auth-user-section');
    const emailLabel = document.getElementById('settings-auth-email');
    const statusBadge = document.getElementById('settings-auth-status-badge');

    if (this.currentUser) {
      if (badge) badge.style.display = 'block';
      if (guestSection) guestSection.style.display = 'none';
      if (userSection) userSection.style.display = 'block';
      if (emailLabel) emailLabel.textContent = this.currentUser.email || this.currentUser.displayName || 'Learner';
      if (statusBadge) {
        statusBadge.textContent = 'Account Synced';
        statusBadge.style.backgroundColor = 'var(--color-success-light)';
        statusBadge.style.color = 'var(--color-success)';
      }
    } else {
      if (badge) badge.style.display = 'none';
      if (guestSection) guestSection.style.display = 'block';
      if (userSection) userSection.style.display = 'none';
      if (statusBadge) {
        statusBadge.textContent = 'Guest Mode';
        statusBadge.style.backgroundColor = 'var(--bg-surface-secondary)';
        statusBadge.style.color = 'var(--text-secondary)';
      }
    }
  }
};

// --------------------------------------------------------------------------
// 3. UI Helpers & Toasts
// --------------------------------------------------------------------------

function showToast(message, icon = '✓') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-message';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

function calculateUnebGrade(percentage) {
  if (percentage >= 80) return { grade: 'D1', title: 'Distinction 1', comment: 'Outstanding performance! Demonstrates complete mastery of core principles.' };
  if (percentage >= 70) return { grade: 'D2', title: 'Distinction 2', comment: 'Very good distinction work with high accuracy.' };
  if (percentage >= 65) return { grade: 'C3', title: 'Credit 3', comment: 'Solid credit work with good conceptual understanding.' };
  if (percentage >= 60) return { grade: 'C4', title: 'Credit 4', comment: 'Satisfactory credit level. Minor revision needed on complex topics.' };
  if (percentage >= 50) return { grade: 'C5', title: 'Credit 5', comment: 'Fair credit performance. Focus on problem-solving mechanics.' };
  if (percentage >= 45) return { grade: 'P7', title: 'Pass 7', comment: 'Basic pass achieved. Recommend reviewing revision guides and notes.' };
  return { grade: 'F9', title: 'Fail 9', comment: 'Needs significant revision. Use the AI Tutor and past papers to strengthen foundation.' };
}

function renderResourceCardHTML(resource, isBookmarked = false) {
  const typeObj = FundishaData.RESOURCE_TYPES.find(t => t.id === resource.type) || { icon: 'file-text', color: 'badge-blue' };
  const iconSvg = getLucideIconSvg(typeObj.icon, 14);
  
  return `
    <article class="resource-card" data-id="${resource.id}">
      <div class="resource-top-bar">
        <span class="resource-type-badge ${typeObj.color}">
          ${iconSvg} <span>${resource.type}</span>
        </span>
        <button type="button" class="bookmark-btn ${isBookmarked ? 'bookmarked' : ''}" 
                data-action="bookmark" data-id="${resource.id}" title="${isBookmarked ? 'Remove Bookmark' : 'Save Resource'}" aria-label="${isBookmarked ? 'Remove Bookmark' : 'Save Resource'}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        </button>
      </div>

      <h3 class="resource-title" data-action="view" data-id="${resource.id}">${escapeHTML(resource.title)}</h3>
      <p class="resource-description">${escapeHTML(resource.description)}</p>

      <div class="resource-tags">
        <span class="badge badge-gray">${escapeHTML(resource.subject)}</span>
        <span class="badge badge-blue">${escapeHTML(resource.class)}</span>
        <span class="badge badge-gray" style="font-size:0.7rem;">${resource.format || 'PDF'} • ${resource.fileSize || '3.5 MB'}</span>
      </div>

      <div class="resource-meta-info">
        <span class="resource-author">${getLucideIconSvg('school', 14)} <span>${escapeHTML(resource.author || 'Fundisha')}</span></span>
        <span style="display:inline-flex; align-items:center; gap:0.35rem;">${getLucideIconSvg('eye', 14)} <span>${(resource.views || 0).toLocaleString()}</span></span>
      </div>

      <div class="resource-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="view" data-id="${resource.id}" aria-label="View ${escapeHTML(resource.title)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          View Resource
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="download" data-id="${resource.id}" aria-label="Download ${escapeHTML(resource.title)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          Download
        </button>
      </div>
    </article>
  `;
}

// --------------------------------------------------------------------------
// 4. View Controllers & Renderers
// --------------------------------------------------------------------------

const UIController = {
  
  navigate(viewId, params = {}) {
    AppState.currentView = viewId;
    window.location.hash = viewId;

    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

    document.querySelectorAll('.nav-link, .bottom-nav-item, .mobile-nav-item').forEach(link => {
      if (link.dataset.nav === viewId) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
      } else {
        link.classList.remove('active');
        link.removeAttribute('aria-current');
      }
    });

    const targetSection = document.getElementById(`view-${viewId}`);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    switch (viewId) {
      case 'home':
        this.renderHomeView();
        break;
      case 'resources':
        this.renderLibraryView(params);
        break;
      case 'resource-detail':
        this.renderResourceDetailView(params.id || AppState.selectedResourceId);
        break;
      case 'subjects':
        this.renderSubjectsDirectory();
        break;
      case 'subject-detail':
        this.renderSubjectDetailView(params.subject || AppState.selectedSubjectId);
        break;
      case 'dashboard':
        this.renderDashboardView();
        break;
      case 'quizzes':
        this.renderQuizzesView();
        break;
      case 'tutor':
        this.renderTutorView(params);
        break;
      case 'saved':
        this.renderSavedResourcesView();
        break;
      case 'settings':
        this.renderSettingsView();
        break;
      case 'about':
        this.renderAboutView();
        break;
      case 'contact':
        this.renderContactView();
        break;
      case 'help':
        this.renderHelpView();
        break;
      case 'faq':
        this.renderFaqView();
        break;
      case 'privacy':
        this.renderPrivacyView();
        break;
      case 'terms':
        this.renderTermsView();
        break;
    }

    this.updateHeaderBadges();
  },

  updateHeaderBadges() {
    const count = StorageService.getBookmarks().length;
    const badge = document.getElementById('bookmarks-badge-count');
    if (badge) badge.textContent = count;

    const chip = document.getElementById('student-chip-label');
    if (chip && AppState.user) {
      chip.textContent = AppState.user.class || 'Senior 5';
    }

    const drawerClassLabel = document.getElementById('mobile-drawer-class-label');
    if (drawerClassLabel && AppState.user) {
      drawerClassLabel.textContent = `${AppState.user.name || 'Student'} • ${AppState.user.class || 'Senior 5'}`;
    }
  },

  renderHomeView() {
    const user = AppState.user;
    const bookmarks = StorageService.getBookmarks();

    const formatsContainer = document.getElementById('home-formats-grid');
    if (formatsContainer) {
      formatsContainer.innerHTML = FundishaData.RESOURCE_TYPES.map(type => {
        const count = FundishaData.RESOURCES.filter(r => r.type === type.id).length;
        const iconSvg = getLucideIconSvg(type.icon, 22);
        return `
          <div class="format-card" data-action="filter-type" data-type="${type.id}">
            <div class="format-icon-box">${iconSvg}</div>
            <div class="format-title">${type.label}</div>
            <div class="format-count">${count} materials</div>
          </div>
        `;
      }).join('');
    }

    const recHeaderTitle = document.getElementById('home-recommended-title');
    const recContainer = document.getElementById('home-recommended-grid');
    if (recContainer && user) {
      if (recHeaderTitle) {
        recHeaderTitle.textContent = `Recommended for ${user.class}`;
      }

      let recommended = FundishaData.RESOURCES.filter(r => 
        r.class === user.class || (user.subjects && user.subjects.includes(r.subject))
      );

      if (recommended.length === 0) {
        recommended = FundishaData.RESOURCES.slice(0, 4);
      }

      recContainer.innerHTML = recommended.slice(0, 4).map(r => 
        renderResourceCardHTML(r, bookmarks.includes(r.id))
      ).join('');
    }

    const subjectsContainer = document.getElementById('home-subjects-grid');
    if (subjectsContainer) {
      subjectsContainer.innerHTML = FundishaData.SUBJECTS.slice(0, 6).map(sub => {
        const resCount = FundishaData.RESOURCES.filter(r => r.subject === sub.name).length;
        const iconSvg = getLucideIconSvg(sub.icon, 22);
        return `
          <div class="subject-card" data-action="open-subject" data-subject="${sub.name}">
            <div class="subject-card-header">
              <div class="subject-icon-wrap">${iconSvg}</div>
              <span class="badge badge-blue">${sub.level}</span>
            </div>
            <div>
              <h3 class="subject-card-title">${sub.name}</h3>
              <div class="subject-card-meta">
                <span>📚 ${resCount} Resources</span>
                <span>•</span>
                <span>🎯 ${sub.topics.length} Topics</span>
              </div>
            </div>
            <div class="subject-topics-preview">
              ${sub.topics.slice(0, 2).map(t => `<span class="topic-chip">${t}</span>`).join('')}
            </div>
            <div class="subject-card-footer">
              <span>Explore Subject Materials</span>
              <span>→</span>
            </div>
          </div>
        `;
      }).join('');
    }

    const pastPapersContainer = document.getElementById('home-pastpapers-grid');
    if (pastPapersContainer) {
      const pastPapers = FundishaData.RESOURCES.filter(r => r.type === 'Past Papers');
      pastPapersContainer.innerHTML = pastPapers.slice(0, 3).map(r => 
        renderResourceCardHTML(r, bookmarks.includes(r.id))
      ).join('');
    }
  },

  renderLibraryView(params = {}) {
    if (params.subject) AppState.activeFilters.subject = params.subject;
    if (params.class) AppState.activeFilters.class = params.class;
    if (params.type) AppState.activeFilters.type = params.type;

    this.renderFilterPills();
    this.applyLibraryFiltersAndRender();
  },

  renderFilterPills() {
    const classContainer = document.getElementById('filter-class-list');
    if (classContainer) {
      const classes = ['All', 'Senior 1', 'Senior 2', 'Senior 3', 'Senior 4', 'Senior 5', 'Senior 6'];
      classContainer.innerHTML = classes.map(c => `
        <div class="filter-pill-item ${AppState.activeFilters.class === c ? 'active' : ''}" data-filter-type="class" data-val="${c}">
          <span>${c}</span>
          <span class="filter-count">${c === 'All' ? FundishaData.RESOURCES.length : FundishaData.RESOURCES.filter(r => r.class === c).length}</span>
        </div>
      `).join('');
    }

    const subjectContainer = document.getElementById('filter-subject-list');
    if (subjectContainer) {
      const subjectList = ['All', ...FundishaData.SUBJECTS.map(s => s.name)];
      subjectContainer.innerHTML = subjectList.map(s => `
        <div class="filter-pill-item ${AppState.activeFilters.subject === s ? 'active' : ''}" data-filter-type="subject" data-val="${s}">
          <span>${s}</span>
          <span class="filter-count">${s === 'All' ? FundishaData.RESOURCES.length : FundishaData.RESOURCES.filter(r => r.subject === s).length}</span>
        </div>
      `).join('');
    }

    const typeContainer = document.getElementById('filter-type-list');
    if (typeContainer) {
      const typeList = ['All', ...FundishaData.RESOURCE_TYPES.map(t => t.id)];
      typeContainer.innerHTML = typeList.map(t => `
        <div class="filter-pill-item ${AppState.activeFilters.type === t ? 'active' : ''}" data-filter-type="type" data-val="${t}">
          <span>${t}</span>
          <span class="filter-count">${t === 'All' ? FundishaData.RESOURCES.length : FundishaData.RESOURCES.filter(r => r.type === t).length}</span>
        </div>
      `).join('');
    }
  },

  applyLibraryFiltersAndRender() {
    const { class: cls, subject, type, search, sort } = AppState.activeFilters;
    const bookmarks = StorageService.getBookmarks();
    const user = AppState.user;

    let results = FundishaData.RESOURCES.filter(r => {
      const matchClass = (cls === 'All' || r.class === cls);
      const matchSubject = (subject === 'All' || r.subject === subject);
      const matchType = (type === 'All' || r.type === type);
      
      let matchSearch = true;
      if (search.trim()) {
        const query = search.toLowerCase();
        matchSearch = r.title.toLowerCase().includes(query) ||
                      r.subject.toLowerCase().includes(query) ||
                      r.topic.toLowerCase().includes(query) ||
                      r.description.toLowerCase().includes(query) ||
                      (r.author && r.author.toLowerCase().includes(query));
      }
      return matchClass && matchSubject && matchType && matchSearch;
    });

    if (sort === 'recommended' && user) {
      results.sort((a, b) => {
        const aScore = (a.class === user.class ? 2 : 0) + (user.subjects && user.subjects.includes(a.subject) ? 2 : 0);
        const bScore = (b.class === user.class ? 2 : 0) + (user.subjects && user.subjects.includes(b.subject) ? 2 : 0);
        return bScore - aScore;
      });
    } else if (sort === 'newest') {
      results.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    } else if (sort === 'popular') {
      results.sort((a, b) => (b.views || 0) - (a.views || 0));
    } else if (sort === 'alpha') {
      results.sort((a, b) => a.title.localeCompare(b.title));
    }

    const counter = document.getElementById('library-results-counter');
    if (counter) {
      counter.textContent = `Showing ${results.length} resources`;
    }

    const chipsContainer = document.getElementById('active-filter-chips');
    if (chipsContainer) {
      let chipsHtml = '';
      if (cls !== 'All') chipsHtml += `<span class="active-chip">Class: ${cls} <span class="active-chip-remove" data-clear="class">✕</span></span>`;
      if (subject !== 'All') chipsHtml += `<span class="active-chip">Subject: ${subject} <span class="active-chip-remove" data-clear="subject">✕</span></span>`;
      if (type !== 'All') chipsHtml += `<span class="active-chip">Type: ${type} <span class="active-chip-remove" data-clear="type">✕</span></span>`;
      if (search) chipsHtml += `<span class="active-chip">Search: "${search}" <span class="active-chip-remove" data-clear="search">✕</span></span>`;
      chipsContainer.innerHTML = chipsHtml;
    }

    const grid = document.getElementById('library-resources-grid');
    const emptyState = document.getElementById('library-empty-state');

    if (grid && emptyState) {
      if (results.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'block';
      } else {
        grid.style.display = 'grid';
        emptyState.style.display = 'none';
        grid.innerHTML = results.map(r => renderResourceCardHTML(r, bookmarks.includes(r.id))).join('');
      }
    }
  },

  renderResourceDetailView(resourceId) {
    const resource = FundishaData.RESOURCES.find(r => r.id === resourceId) || FundishaData.RESOURCES[0];
    AppState.selectedResourceId = resource.id;

    // Track recently viewed & record interaction in Firestore
    StorageService.addRecentlyViewed(resource.id);
    StorageService.addPoints(5);
    recordResourceInteraction(resource.id, 'view').catch(() => {});

    // Breadcrumbs
    const bcSub = document.getElementById('breadcrumb-subject');
    const bcTitle = document.getElementById('breadcrumb-title');
    if (bcSub) bcSub.textContent = resource.subject;
    if (bcTitle) bcTitle.textContent = resource.title;

    // Metadata
    document.getElementById('detail-resource-title').textContent = resource.title;
    document.getElementById('detail-resource-desc').textContent = resource.description;
    document.getElementById('detail-meta-class').textContent = `${resource.subject} • ${resource.class}`;
    document.getElementById('detail-meta-author').textContent = resource.author || 'Fundisha';
    document.getElementById('detail-meta-type').textContent = resource.type;
    document.getElementById('detail-meta-file').textContent = `${resource.format || 'PDF'} • ${resource.fileSize || '3.5 MB'} • ${resource.pages || 30} Pages`;
    document.getElementById('detail-stats-views').textContent = `👀 ${(resource.views || 1000).toLocaleString()} views • 📥 ${(resource.downloads || 500).toLocaleString()} downloads`;

    // Tags
    const tagsWrap = document.getElementById('detail-tags-wrap');
    if (tagsWrap) {
      tagsWrap.innerHTML = `
        <span class="badge badge-blue">${resource.class}</span>
        <span class="badge badge-emerald">${resource.subject}</span>
        <span class="badge badge-purple">${resource.topic}</span>
      `;
    }

    // Bookmark button state
    const isBookmarked = StorageService.getBookmarks().includes(resource.id);
    const bmBtn = document.getElementById('detail-bookmark-btn');
    const bmText = document.getElementById('detail-bookmark-text');
    if (bmBtn && bmText) {
      bmText.textContent = isBookmarked ? 'Bookmarked' : 'Save Resource';
      bmBtn.className = `btn btn-sm ${isBookmarked ? 'btn-accent' : 'btn-secondary'}`;
    }

    // Reader content
    const sheetBody = document.getElementById('sheet-main-body');
    if (sheetBody) {
      sheetBody.innerHTML = `
        <div class="sheet-callout">
          <strong>Uganda National Curriculum Objectives:</strong>
          <ul style="margin-top: 0.5rem; padding-left: 1.25rem; list-style-type: disc;">
            ${(resource.objectives || ['Master fundamental UNEB concepts and examination techniques']).map(obj => `<li>${obj}</li>`).join('')}
          </ul>
        </div>

        <h3 style="font-size: 1.15rem; font-weight: 700; color: var(--brand-primary); margin-top: 0.5rem;">Section 1: Theoretical Foundation & Formulas</h3>
        <p>
          This document has been reviewed against the <strong>National Curriculum Development Centre (NCDC)</strong> Uganda syllabus requirements. 
          Students preparing for UNEB examinations should master all definitions, derivations, and worked sample problems presented in this guide.
        </p>

        <div style="padding: 1.25rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 0.875rem;">
          // Syllabus Coverage: ${resource.topic} [Class: ${resource.class}]<br>
          // Institution: ${resource.author || 'Fundisha'}<br>
          // Status: Verified Free Educational Material (Firebase Cloud Storage Compatible)
        </div>

        <p>
          <em>Note:</em> Real PDF rendering and document streaming integrate with Firebase Storage and cloud PDF viewers. Use the download button above to save an offline copy directly to your device.
        </p>
      `;
    }

    // Related Resources Grid
    const relatedGrid = document.getElementById('detail-related-grid');
    if (relatedGrid) {
      const bookmarks = StorageService.getBookmarks();
      const related = FundishaData.RESOURCES.filter(r => 
        r.id !== resource.id && (r.subject === resource.subject || r.class === resource.class)
      ).slice(0, 3);

      relatedGrid.innerHTML = related.map(r => renderResourceCardHTML(r, bookmarks.includes(r.id))).join('');
    }
  },

  renderSubjectsDirectory() {
    const container = document.getElementById('subjects-all-grid');
    if (!container) return;

    container.innerHTML = FundishaData.SUBJECTS.map(sub => {
      const resCount = FundishaData.RESOURCES.filter(r => r.subject === sub.name).length;
      const iconSvg = getLucideIconSvg(sub.icon, 22);
      return `
        <div class="subject-card" data-action="open-subject" data-subject="${sub.name}">
          <div class="subject-card-header">
            <div class="subject-icon-wrap">${iconSvg}</div>
            <span class="badge badge-blue">${sub.category}</span>
          </div>
          <div>
            <h3 class="subject-card-title">${sub.name}</h3>
            <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.35rem; line-height: 1.4;">${sub.description}</p>
          </div>
          <div class="subject-card-meta">
            <span>📚 ${resCount} Resources</span>
            <span>•</span>
            <span>🎯 ${sub.topics.length} Topics</span>
          </div>
          <div class="subject-card-footer">
            <span>View Syllabus & Resources</span>
            <span>→</span>
          </div>
        </div>
      `;
    }).join('');
  },

  renderSubjectDetailView(subjectName) {
    const subject = FundishaData.SUBJECTS.find(s => s.name === subjectName) || FundishaData.SUBJECTS[0];
    AppState.selectedSubjectId = subject.name;

    document.getElementById('subject-page-breadcrumb').textContent = subject.name;
    const bannerIcon = document.getElementById('subject-banner-icon');
    if (bannerIcon) {
      bannerIcon.innerHTML = getLucideIconSvg(subject.icon, 28);
    }
    document.getElementById('subject-banner-title').textContent = subject.name;
    document.getElementById('subject-banner-desc').textContent = subject.description;
    document.getElementById('subject-banner-badge').textContent = `${subject.level} • ${subject.category}`;

    const topicsGrid = document.getElementById('subject-topics-grid');
    if (topicsGrid) {
      topicsGrid.innerHTML = subject.topics.map(topic => `
        <div class="format-card" data-action="filter-library-topic" data-subject="${subject.name}" data-topic="${topic}">
          <div class="format-icon-box" style="width:36px; height:36px;">${getLucideIconSvg('pin', 16)}</div>
          <div class="format-title" style="font-size: 0.8rem;">${topic}</div>
        </div>
      `).join('');
    }

    const resGrid = document.getElementById('subject-resources-grid');
    if (resGrid) {
      const bookmarks = StorageService.getBookmarks();
      const subjectResources = FundishaData.RESOURCES.filter(r => r.subject === subject.name);
      
      if (subjectResources.length > 0) {
        resGrid.innerHTML = subjectResources.map(r => renderResourceCardHTML(r, bookmarks.includes(r.id))).join('');
      } else {
        resGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-muted);">More ${subject.name} resources are being uploaded for your syllabus.</div>`;
      }
    }
  },

  async renderDashboardView() {
    const user = AppState.user;
    const streak = StorageService.getStreak();
    const points = StorageService.getPoints();
    const bookmarks = StorageService.getBookmarks();
    const quizHistory = StorageService.getQuizHistory();
    const recentIds = StorageService.getRecentlyViewed();

    const hour = new Date().getHours();
    let timeGreeting = 'Good morning';
    if (hour >= 12 && hour < 17) timeGreeting = 'Good afternoon';
    else if (hour >= 17) timeGreeting = 'Good evening';

    document.getElementById('dash-greeting-text').textContent = `${timeGreeting}, ${user.name || 'Scholar'} 👋`;
    document.getElementById('dash-user-meta-text').textContent = `${user.class} Student • ${(user.subjects || []).length} Enrolled Subjects`;

    document.getElementById('dash-streak-val').textContent = streak.count;
    document.getElementById('dash-points-val').textContent = points.toLocaleString();
    document.getElementById('dash-bookmarks-val').textContent = bookmarks.length;
    document.getElementById('dash-quizzes-val').textContent = quizHistory.length;

    const recentGrid = document.getElementById('dash-recent-grid');
    if (recentGrid) {
      const recentResources = recentIds.map(id => FundishaData.RESOURCES.find(r => r.id === id)).filter(Boolean);
      if (recentResources.length > 0) {
        recentGrid.innerHTML = recentResources.slice(0, 3).map(r => renderResourceCardHTML(r, bookmarks.includes(r.id))).join('');
      } else {
        recentGrid.innerHTML = `<div style="grid-column:1/-1; padding: 1.5rem; background: var(--bg-surface); border-radius: var(--radius-lg); color: var(--text-muted); font-size: 0.9rem;">No recently opened materials yet. Explore the resource library to start studying!</div>`;
      }
    }

    const recGrid = document.getElementById('dash-recommended-grid');
    if (recGrid) {
      const recommended = FundishaData.RESOURCES.filter(r => 
        r.class === user.class && user.subjects && user.subjects.includes(r.subject)
      );
      recGrid.innerHTML = (recommended.length > 0 ? recommended : FundishaData.RESOURCES.slice(0, 4))
        .map(r => renderResourceCardHTML(r, bookmarks.includes(r.id))).join('');
    }

    const savedList = document.getElementById('dash-saved-list');
    if (savedList) {
      const savedResources = bookmarks.map(id => FundishaData.RESOURCES.find(r => r.id === id)).filter(Boolean);
      if (savedResources.length > 0) {
        savedList.innerHTML = savedResources.slice(0, 4).map(r => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.65rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-size: 0.85rem;">
            <span style="font-weight: 600; cursor: pointer;" data-action="view" data-id="${r.id}">${escapeHTML(r.title.slice(0, 36))}...</span>
            <span class="badge badge-blue" style="font-size:0.7rem;">${r.subject}</span>
          </div>
        `).join('');
      } else {
        savedList.innerHTML = `<div style="font-size: 0.825rem; color: var(--text-muted);">No saved items yet. Bookmark notes and past papers for quick reference.</div>`;
      }
    }

    const masteryList = document.getElementById('dash-mastery-list');
    if (masteryList) {
      const subjectsWithQuizzes = ['Mathematics', 'Physics', 'Chemistry', 'Biology'];
      masteryList.innerHTML = subjectsWithQuizzes.map(sub => {
        const attempts = quizHistory.filter(q => q.subject === sub);
        const avgScore = attempts.length > 0 
          ? Math.round(attempts.reduce((acc, q) => acc + q.score, 0) / attempts.length) 
          : 70;
        
        return `
          <div>
            <div style="display: flex; justify-content: space-between; font-size: 0.825rem; font-weight: 600; margin-bottom: 0.25rem;">
              <span>${sub}</span>
              <span>${avgScore}% Mastery</span>
            </div>
            <div style="height: 6px; background: var(--bg-surface-secondary); border-radius: var(--radius-full); overflow: hidden;">
              <div style="width: ${avgScore}%; height: 100%; background: var(--brand-primary);"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Populate Leaderboard
    const lbContainer = document.getElementById('dash-leaderboard-list');
    if (lbContainer) {
      lbContainer.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-muted);">Loading nationwide scholars...</div>`;
      const leaders = await getLeaderboard(5);
      if (leaders && leaders.length > 0) {
        lbContainer.innerHTML = leaders.map((ldr, idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
          return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.65rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-size: 0.825rem;">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="font-weight: 700; width: 20px;">${medal}</span>
                <span style="font-weight: 600;">${escapeHTML(ldr.name || 'Scholar')}</span>
              </div>
              <span style="color: var(--brand-primary); font-weight: 700;">${(ldr.points || 0).toLocaleString()} XP</span>
            </div>
          `;
        }).join('');
      } else {
        lbContainer.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.65rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-size: 0.825rem;">
            <span>🥇 Sarah Nabatanzi (Gayaza)</span>
            <span style="color: var(--brand-primary); font-weight: 700;">1,420 XP</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.65rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-size: 0.825rem;">
            <span>🥈 Emmanuel Okello (SMACK)</span>
            <span style="color: var(--brand-primary); font-weight: 700;">1,180 XP</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.65rem; background: var(--bg-surface-secondary); border-radius: var(--radius-md); font-size: 0.825rem;">
            <span>🥉 ${escapeHTML(user.name || 'You')} (${user.class})</span>
            <span style="color: var(--brand-primary); font-weight: 700;">${points.toLocaleString()} XP</span>
          </div>
        `;
      }
    }
  },

  renderQuizzesView() {
    const subjectSelect = document.getElementById('quiz-subject-select');
    if (subjectSelect) {
      subjectSelect.innerHTML = FundishaData.SUBJECTS.map(s => 
        `<option value="${s.name}" ${AppState.user.subjects && AppState.user.subjects.includes(s.name) ? 'selected' : ''}>${s.name}</option>`
      ).join('');
    }

    document.getElementById('quiz-setup-container').style.display = 'block';
    document.getElementById('quiz-runner-container').style.display = 'none';
    document.getElementById('quiz-results-container').style.display = 'none';
  },

  async startQuiz(subject, count) {
    let available = await getQuizzesBySubject(subject);
    if (!available || available.length === 0) {
      available = FundishaData.QUIZZES_DATA[subject] || FundishaData.QUIZZES_DATA['Mathematics'];
    }

    AppState.currentQuiz = {
      subject,
      questions: available.slice(0, count),
      currentIndex: 0,
      userAnswers: new Array(Math.min(available.length, count)).fill(null),
      isSubmitted: false
    };

    document.getElementById('quiz-setup-container').style.display = 'none';
    document.getElementById('quiz-runner-container').style.display = 'block';
    document.getElementById('quiz-results-container').style.display = 'none';

    this.renderActiveQuizQuestion();
  },

  renderActiveQuizQuestion() {
    const { questions, currentIndex, userAnswers, subject } = AppState.currentQuiz;
    const currentQ = questions[currentIndex];

    document.getElementById('quiz-live-subject-badge').textContent = subject;
    document.getElementById('quiz-question-counter').textContent = `Question ${currentIndex + 1} of ${questions.length}`;
    
    const percent = ((currentIndex + 1) / questions.length) * 100;
    document.getElementById('quiz-progress-fill').style.width = `${percent}%`;

    document.getElementById('quiz-question-text').textContent = currentQ.question;

    const letters = ['A', 'B', 'C', 'D'];
    const optionsContainer = document.getElementById('quiz-options-container');
    optionsContainer.innerHTML = currentQ.options.map((opt, idx) => {
      const isSelected = userAnswers[currentIndex] === idx;
      return `
        <button type="button" class="quiz-option-btn ${isSelected ? 'selected' : ''}" data-opt-idx="${idx}">
          <span class="quiz-option-letter">${letters[idx]}</span>
          <span>${escapeHTML(opt)}</span>
        </button>
      `;
    }).join('');

    const prevBtn = document.getElementById('quiz-prev-btn');
    const nextBtn = document.getElementById('quiz-next-btn');

    prevBtn.disabled = currentIndex === 0;
    if (currentIndex === questions.length - 1) {
      nextBtn.textContent = 'Submit & Grade Quiz ✓';
      nextBtn.className = 'btn btn-accent';
    } else {
      nextBtn.textContent = 'Next Question →';
      nextBtn.className = 'btn btn-primary';
    }
  },

  submitAndGradeQuiz() {
    const { questions, userAnswers, subject } = AppState.currentQuiz;
    let correctCount = 0;

    questions.forEach((q, idx) => {
      if (userAnswers[idx] === q.answer) {
        correctCount++;
      }
    });

    const scorePercent = Math.round((correctCount / questions.length) * 100);
    const unebGrade = calculateUnebGrade(scorePercent);

    StorageService.saveQuizResult({
      subject,
      score: scorePercent,
      grade: unebGrade.grade,
      date: new Date().toISOString()
    });

    document.getElementById('quiz-runner-container').style.display = 'none';
    document.getElementById('quiz-results-container').style.display = 'block';

    document.getElementById('quiz-result-grade').textContent = unebGrade.grade;
    document.getElementById('quiz-result-percent').textContent = `${scorePercent}% (${correctCount}/${questions.length})`;
    document.getElementById('quiz-result-comment').textContent = `${unebGrade.title}: ${unebGrade.comment}`;
    document.getElementById('quiz-score-circle').style.setProperty('--percent', scorePercent);

    const reviewList = document.getElementById('quiz-review-list');
    reviewList.innerHTML = questions.map((q, idx) => {
      const isCorrect = userAnswers[idx] === q.answer;
      return `
        <div style="padding: 1rem; border-radius: var(--radius-md); background: ${isCorrect ? 'var(--color-success-light)' : 'var(--color-danger-light)'}; border-left: 4px solid ${isCorrect ? 'var(--color-success)' : 'var(--color-danger)'};">
          <div style="font-weight: 700; font-size: 0.95rem;">Q${idx + 1}: ${escapeHTML(q.question)}</div>
          <div style="margin-top: 0.35rem; font-size: 0.85rem;">
            <strong>Your Answer:</strong> ${userAnswers[idx] !== null ? escapeHTML(q.options[userAnswers[idx]]) : 'Unanswered'} 
            ${isCorrect ? '✅ Correct' : '❌ Incorrect'}
          </div>
          <div style="margin-top: 0.25rem; font-size: 0.85rem; color: var(--text-secondary);">
            <strong>Correct Answer:</strong> ${escapeHTML(q.options[q.answer])}
          </div>
          <div style="margin-top: 0.4rem; font-size: 0.825rem; font-style: italic; color: var(--text-muted);">
            💡 <em>Explanation:</em> ${escapeHTML(q.explanation)}
          </div>
        </div>
      `;
    }).join('');

    showToast(`Quiz completed! +50 XP added to your study points.`);
  },

  renderTutorView(params = {}) {
    const subjectSelect = document.getElementById('tutor-subject-select');
    if (subjectSelect) {
      subjectSelect.innerHTML = FundishaData.SUBJECTS.map(s => 
        `<option value="${s.name}" ${AppState.user.subjects && AppState.user.subjects.includes(s.name) ? 'selected' : ''}>${s.name}</option>`
      ).join('');
    }

    if (params.ask) {
      const input = document.getElementById('tutor-user-input');
      if (input) {
        input.value = params.ask;
        this.sendTutorMessage(params.ask);
      }
    }
  },

  async sendTutorMessage(questionText) {
    if (!questionText.trim()) return;

    const stream = document.getElementById('tutor-messages-stream');
    const input = document.getElementById('tutor-user-input');
    const activeSubject = document.getElementById('tutor-subject-select').value;
    const userClass = AppState.user.class;

    const userMsg = document.createElement('div');
    userMsg.className = 'chat-message user';
    userMsg.innerHTML = `
      <div class="chat-avatar user">👤</div>
      <div class="chat-bubble">${escapeHTML(questionText)}</div>
    `;
    stream.appendChild(userMsg);
    input.value = '';
    stream.scrollTop = stream.scrollHeight;

    const typingMsg = document.createElement('div');
    typingMsg.className = 'chat-message tutor';
    typingMsg.id = 'tutor-typing-indicator';
    typingMsg.innerHTML = `
      <div class="chat-avatar tutor">✨</div>
      <div class="chat-bubble" style="font-style: italic; opacity: 0.8;">Fundisha AI is referencing Ugandan curriculum notes...</div>
    `;
    stream.appendChild(typingMsg);
    stream.scrollTop = stream.scrollHeight;

    let replyHtml = '';

    try {
      // Call backend Gemini AI Tutor endpoint
      const response = await fetch('/api/ai-tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: questionText,
          context: {
            class: userClass,
            subject: activeSubject
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        replyHtml = formatMarkdownToHTML(data.reply || '');
      }
    } catch (err) {
      // Offline fallback
    }

    if (!replyHtml) {
      const lower = questionText.toLowerCase();
      if (lower.includes('newton') || lower.includes('motion')) {
        replyHtml = formatMarkdownToHTML(FundishaData.AI_KNOWLEDGE['newton'].text);
      } else if (lower.includes('differentiat') || lower.includes('calculus') || lower.includes('derivative')) {
        replyHtml = formatMarkdownToHTML(FundishaData.AI_KNOWLEDGE['differentiation'].text);
      } else if (lower.includes('buganda') || lower.includes('1900') || lower.includes('agreement')) {
        replyHtml = formatMarkdownToHTML(FundishaData.AI_KNOWLEDGE['buganda'].text);
      } else {
        replyHtml = `
          <strong>Educational Guidance for ${userClass} ${activeSubject}:</strong>
          <br><br>
          Thank you for asking about <em>"${escapeHTML(questionText)}"</em>.
          <br><br>
          In the Ugandan <strong>${userClass} ${activeSubject}</strong> curriculum, master the fundamental definitions and structured step-by-step examination answers.
          <br><br>
          📌 <strong>Key Principles to Remember:</strong>
          <ul style="padding-left: 1.25rem; margin-top: 0.4rem; list-style-type: disc;">
            <li>Always state SI units when calculating physical quantities.</li>
            <li>In essay or theory questions, clearly show formulas before substituting numbers.</li>
            <li>Refer to past papers in the Resource Library for standard marking schemes.</li>
          </ul>
        `;
      }
    }

    typingMsg.remove();
    const tutorReply = document.createElement('div');
    tutorReply.className = 'chat-message tutor';
    tutorReply.innerHTML = `
      <div class="chat-avatar tutor">✨</div>
      <div class="chat-bubble">${replyHtml}</div>
    `;
    stream.appendChild(tutorReply);
    stream.scrollTop = stream.scrollHeight;
  },

  renderSavedResourcesView() {
    const bookmarks = StorageService.getBookmarks();
    const grid = document.getElementById('saved-resources-grid');
    const empty = document.getElementById('saved-empty-state');

    const savedItems = bookmarks.map(id => FundishaData.RESOURCES.find(r => r.id === id)).filter(Boolean);

    if (savedItems.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
    } else {
      grid.style.display = 'grid';
      empty.style.display = 'none';
      grid.innerHTML = savedItems.map(r => renderResourceCardHTML(r, true)).join('');
    }
  },

  renderSettingsView() {
    const user = AppState.user;
    const nameInput = document.getElementById('settings-name-input');
    const classSelect = document.getElementById('settings-class-select');
    const subjectsGrid = document.getElementById('settings-subjects-grid');

    if (nameInput) nameInput.value = user.name || '';
    if (classSelect) classSelect.value = user.class || 'Senior 5';

    if (subjectsGrid) {
      subjectsGrid.innerHTML = FundishaData.SUBJECTS.map(s => {
        const isChecked = user.subjects && user.subjects.includes(s.name);
        return `
          <div class="subject-choice-card ${isChecked ? 'selected' : ''}" data-subject-val="${s.name}">
            <span style="display:inline-flex; align-items:center; gap:0.5rem;">${getLucideIconSvg(s.icon, 16)} <span>${s.name}</span></span>
          </div>
        `;
      }).join('');
    }

    AppState.updateAuthUI();
  },

  renderAboutView() {
    // Dynamic refresh or team animations if needed
  },

  renderContactView() {
    const classSelect = document.getElementById('contact-class');
    if (classSelect && AppState.user && AppState.user.class) {
      classSelect.value = AppState.user.class;
    }
  },

  renderHelpView() {
    // Help content view
  },

  renderFaqView() {
    const container = document.getElementById('faq-accordion-container');
    if (!container) return;

    const faqs = FundishaData.FAQS || [];
    container.innerHTML = faqs.map((faq, idx) => `
      <div class="faq-accordion-item" style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden; transition: all var(--transition-fast);">
        <button type="button" class="faq-question-btn" data-faq-idx="${idx}" style="width: 100%; text-align: left; padding: 1.25rem 1.5rem; background: none; border: none; font-size: 1.05rem; font-weight: 700; color: var(--text-primary); display: flex; justify-content: space-between; align-items: center; cursor: pointer; gap: 1rem;">
          <span>${escapeHTML(faq.q)}</span>
          <span class="faq-icon" style="font-size: 1.25rem; color: var(--brand-primary); transition: transform 0.2s ease;">+</span>
        </button>
        <div class="faq-answer-pane" id="faq-answer-${idx}" style="display: none; padding: 0 1.5rem 1.25rem 1.5rem; color: var(--text-secondary); font-size: 0.95rem; line-height: 1.65; border-top: 1px solid var(--border-subtle); padding-top: 1rem;">
          ${escapeHTML(faq.a)}
        </div>
      </div>
    `).join('');
  },

  renderPrivacyView() {
    // Privacy view ready
  },

  renderTermsView() {
    // Terms view ready
  }
};

// --------------------------------------------------------------------------
// 5. Global Event Listeners & Modals Setup
// --------------------------------------------------------------------------

function setupEventListeners() {

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1) || 'home';
    const [view, queryStr] = hash.split('?');
    const params = {};
    if (queryStr) {
      const urlParams = new URLSearchParams(queryStr);
      for (const [k, v] of urlParams.entries()) params[k] = v;
    }
    UIController.navigate(view, params);
  });

  const themeToggle = document.getElementById('theme-toggle-btn');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      StorageService.setTheme(next);
      AppState.updateThemeIcons(next);
    });
  }

  // Header Auth Button Click
  const headerAuthBtn = document.getElementById('header-auth-btn');
  if (headerAuthBtn) {
    headerAuthBtn.addEventListener('click', () => {
      if (AppState.currentUser) {
        UIController.navigate('settings');
      } else {
        openAuthModal('login');
      }
    });
  }

  // Mobile Menu Drawer
  const menuToggle = document.getElementById('mobile-menu-toggle');
  const drawer = document.getElementById('mobile-nav-drawer');
  const backdrop = document.getElementById('mobile-nav-backdrop');

  function toggleMenu(open) {
    if (!drawer || !backdrop) return;
    const isOpen = open !== undefined ? open : !drawer.classList.contains('active');
    drawer.classList.toggle('active', isOpen);
    backdrop.classList.toggle('active', isOpen);
    if (menuToggle) {
      menuToggle.classList.toggle('active', isOpen);
      menuToggle.setAttribute('aria-expanded', isOpen);
    }
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }

  if (menuToggle) menuToggle.addEventListener('click', (e) => {
    e.preventDefault();
    toggleMenu();
  });

  const drawerCloseBtn = document.getElementById('mobile-drawer-close-btn') || document.querySelector('.mobile-drawer-close');
  if (drawerCloseBtn) {
    drawerCloseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleMenu(false);
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', () => toggleMenu(false));
  }

  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => toggleMenu(false));
  });

  const mobileSearchTrigger = document.getElementById('mobile-drawer-search-trigger');
  if (mobileSearchTrigger) {
    mobileSearchTrigger.addEventListener('click', () => {
      toggleMenu(false);
      const modal = document.getElementById('search-modal');
      const input = document.getElementById('quick-search-modal-input');
      if (modal) {
        modal.classList.add('active');
        if (input) {
          input.value = '';
          input.focus();
        }
      }
    });
  }

  const mobileProfileBtn = document.getElementById('mobile-drawer-profile-btn');
  if (mobileProfileBtn) {
    mobileProfileBtn.addEventListener('click', () => {
      toggleMenu(false);
      UIController.navigate('settings');
    });
  }

  // Global Delegated Click Actions
  document.addEventListener('click', async (e) => {
    // 0. Footer Navigation Links
    const footerNav = e.target.closest('[data-footer-nav]');
    if (footerNav) {
      e.preventDefault();
      const navTarget = footerNav.dataset.footerNav;
      UIController.navigate(navTarget);
      return;
    }

    const footerFilter = e.target.closest('[data-footer-filter]');
    if (footerFilter) {
      e.preventDefault();
      const type = footerFilter.dataset.footerFilter;
      UIController.navigate('resources', { type });
      return;
    }

    const footerSubject = e.target.closest('[data-footer-subject]');
    if (footerSubject) {
      e.preventDefault();
      const subject = footerSubject.dataset.footerSubject;
      UIController.navigate('resources', { subject });
      return;
    }

    // FAQ Accordion Toggles
    const faqBtn = e.target.closest('.faq-question-btn');
    if (faqBtn) {
      e.preventDefault();
      const idx = faqBtn.dataset.faqIdx;
      const pane = document.getElementById(`faq-answer-${idx}`);
      const icon = faqBtn.querySelector('.faq-icon');
      if (pane) {
        const isShown = pane.style.display === 'block';
        pane.style.display = isShown ? 'none' : 'block';
        if (icon) icon.textContent = isShown ? '+' : '−';
      }
      return;
    }

    // Hero Class Quick Pills
    const classPill = e.target.closest('.class-pill');
    if (classPill) {
      const cls = classPill.dataset.class;
      document.querySelectorAll('.class-pill').forEach(p => p.classList.remove('active'));
      classPill.classList.add('active');
      AppState.user.class = cls;
      StorageService.saveProfile(AppState.user);
      UIController.updateHeaderBadges();
      showToast(`Viewing curriculum recommendations for ${cls}`);
      UIController.renderHomeView();
      return;
    }

    // 1. Bookmark button
    const bmBtn = e.target.closest('[data-action="bookmark"]');
    if (bmBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = bmBtn.dataset.id;
      const res = await StorageService.toggleBookmark(id);
      
      bmBtn.classList.toggle('bookmarked', res.isSaved);
      const svg = bmBtn.querySelector('svg');
      if (svg) svg.setAttribute('fill', res.isSaved ? 'currentColor' : 'none');

      UIController.updateHeaderBadges();
      showToast(res.isSaved ? 'Saved to bookmarks' : 'Removed from bookmarks', res.isSaved ? '📌' : '✕');
      return;
    }

    // 2. View Resource
    const viewBtn = e.target.closest('[data-action="view"]');
    if (viewBtn) {
      const id = viewBtn.dataset.id;
      UIController.navigate('resource-detail', { id });
      return;
    }

    // 3. Download Resource
    const dlBtn = e.target.closest('[data-action="download"]');
    if (dlBtn) {
      const id = dlBtn.dataset.id;
      const res = FundishaData.RESOURCES.find(r => r.id === id);
      if (res) {
        simulateDownload(res);
        recordResourceInteraction(id, 'download').catch(() => {});
      }
      return;
    }

    // 4. Open Subject
    const subCard = e.target.closest('[data-action="open-subject"]');
    if (subCard) {
      const subject = subCard.dataset.subject;
      UIController.navigate('subject-detail', { subject });
      return;
    }

    // 5. Filter Type from Home
    const formatCard = e.target.closest('[data-action="filter-type"]');
    if (formatCard) {
      const type = formatCard.dataset.type;
      UIController.navigate('resources', { type });
      return;
    }

    // 6. Filter by Topic
    const topicCard = e.target.closest('[data-action="filter-library-topic"]');
    if (topicCard) {
      const subject = topicCard.dataset.subject;
      const topic = topicCard.dataset.topic;
      AppState.activeFilters.search = topic;
      UIController.navigate('resources', { subject });
      return;
    }

    // 7. Library Filter Pills
    const pill = e.target.closest('.filter-pill-item');
    if (pill) {
      const type = pill.dataset.filterType;
      const val = pill.dataset.val;
      AppState.activeFilters[type] = val;
      UIController.renderFilterPills();
      UIController.applyLibraryFiltersAndRender();
      return;
    }

    // 8. Active Filter Chip Removes
    const chipRemove = e.target.closest('.active-chip-remove');
    if (chipRemove) {
      const clear = chipRemove.dataset.clear;
      if (clear === 'search') {
        AppState.activeFilters.search = '';
        const sInput = document.getElementById('library-search-input');
        if (sInput) sInput.value = '';
      } else {
        AppState.activeFilters[clear] = 'All';
      }
      UIController.renderFilterPills();
      UIController.applyLibraryFiltersAndRender();
      return;
    }

    // 9. Quiz Option Selection
    const quizOpt = e.target.closest('.quiz-option-btn');
    if (quizOpt) {
      const optIdx = parseInt(quizOpt.dataset.optIdx, 10);
      AppState.currentQuiz.userAnswers[AppState.currentQuiz.currentIndex] = optIdx;
      document.querySelectorAll('.quiz-option-btn').forEach(b => b.classList.remove('selected'));
      quizOpt.classList.add('selected');
      return;
    }
  });

  // Library Search Input
  const searchInput = document.getElementById('library-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      AppState.activeFilters.search = e.target.value;
      UIController.applyLibraryFiltersAndRender();
    });
  }

  // Library Sort Select
  const sortSelect = document.getElementById('library-sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      AppState.activeFilters.sort = e.target.value;
      UIController.applyLibraryFiltersAndRender();
    });
  }

  // Detail Page Action Buttons
  const detailDownloadBtn = document.getElementById('detail-download-btn');
  if (detailDownloadBtn) {
    detailDownloadBtn.addEventListener('click', () => {
      const res = FundishaData.RESOURCES.find(r => r.id === AppState.selectedResourceId) || FundishaData.RESOURCES[0];
      simulateDownload(res);
      recordResourceInteraction(res.id, 'download').catch(() => {});
    });
  }

  const detailBookmarkBtn = document.getElementById('detail-bookmark-btn');
  if (detailBookmarkBtn) {
    detailBookmarkBtn.addEventListener('click', async () => {
      const res = await StorageService.toggleBookmark(AppState.selectedResourceId);
      const bmText = document.getElementById('detail-bookmark-text');
      if (bmText) bmText.textContent = res.isSaved ? 'Bookmarked' : 'Save Resource';
      detailBookmarkBtn.className = `btn btn-sm ${res.isSaved ? 'btn-accent' : 'btn-secondary'}`;
      UIController.updateHeaderBadges();
      showToast(res.isSaved ? 'Saved to bookmarks' : 'Removed from bookmarks');
    });
  }

  const detailAskAiBtn = document.getElementById('detail-ask-ai-btn');
  if (detailAskAiBtn) {
    detailAskAiBtn.addEventListener('click', () => {
      const res = FundishaData.RESOURCES.find(r => r.id === AppState.selectedResourceId) || FundishaData.RESOURCES[0];
      UIController.navigate('tutor', { ask: `Explain key examination concepts for ${res.title}` });
    });
  }

  const detailShareBtn = document.getElementById('detail-share-btn');
  if (detailShareBtn) {
    detailShareBtn.addEventListener('click', () => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(window.location.href);
        showToast('Link copied to clipboard!', '🔗');
      } else {
        showToast('Resource link ready to share');
      }
    });
  }

  const detailReportBtn = document.getElementById('detail-report-btn');
  if (detailReportBtn) {
    detailReportBtn.addEventListener('click', () => {
      const res = FundishaData.RESOURCES.find(r => r.id === AppState.selectedResourceId) || FundishaData.RESOURCES[0];
      openReportModal(res);
    });
  }

  // Quiz Setup Start Button
  const quizStartBtn = document.getElementById('quiz-start-btn');
  if (quizStartBtn) {
    quizStartBtn.addEventListener('click', () => {
      const subject = document.getElementById('quiz-subject-select').value;
      const count = parseInt(document.getElementById('quiz-length-select').value, 10);
      UIController.startQuiz(subject, count);
    });
  }

  const quizPrevBtn = document.getElementById('quiz-prev-btn');
  if (quizPrevBtn) {
    quizPrevBtn.addEventListener('click', () => {
      if (AppState.currentQuiz.currentIndex > 0) {
        AppState.currentQuiz.currentIndex--;
        UIController.renderActiveQuizQuestion();
      }
    });
  }

  const quizNextBtn = document.getElementById('quiz-next-btn');
  if (quizNextBtn) {
    quizNextBtn.addEventListener('click', () => {
      if (AppState.currentQuiz.currentIndex === AppState.currentQuiz.questions.length - 1) {
        UIController.submitAndGradeQuiz();
      } else {
        AppState.currentQuiz.currentIndex++;
        UIController.renderActiveQuizQuestion();
      }
    });
  }

  const quizRetakeBtn = document.getElementById('quiz-retake-btn');
  if (quizRetakeBtn) {
    quizRetakeBtn.addEventListener('click', () => {
      UIController.renderQuizzesView();
    });
  }

  // AI Tutor Form
  const tutorForm = document.getElementById('tutor-chat-form');
  if (tutorForm) {
    tutorForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('tutor-user-input');
      UIController.sendTutorMessage(input.value);
    });
  }

  document.querySelectorAll('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      UIController.sendTutorMessage(prompt);
    });
  });

  const tutorClearBtn = document.getElementById('tutor-clear-chat-btn');
  if (tutorClearBtn) {
    tutorClearBtn.addEventListener('click', () => {
      const stream = document.getElementById('tutor-messages-stream');
      stream.innerHTML = `
        <div class="chat-message tutor">
          <div class="chat-avatar tutor">✨</div>
          <div class="chat-bubble">Conversation cleared. What would you like to study next?</div>
        </div>
      `;
    });
  }

  // Settings Profile Form
  const settingsForm = document.getElementById('settings-profile-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('settings-name-input').value;
      const cls = document.getElementById('settings-class-select').value;
      
      const selectedSubs = [];
      document.querySelectorAll('#settings-subjects-grid .subject-choice-card.selected').forEach(card => {
        selectedSubs.push(card.dataset.subjectVal);
      });

      AppState.user.name = name;
      AppState.user.class = cls;
      AppState.user.subjects = selectedSubs.length > 0 ? selectedSubs : ['Mathematics', 'Physics'];
      StorageService.saveProfile(AppState.user);

      if (AppState.currentUser) {
        await updateUserProfile(AppState.currentUser.uid, {
          name: AppState.user.name,
          class: AppState.user.class,
          subjects: AppState.user.subjects
        });
      }

      showToast('Profile and class preferences updated!');
      UIController.updateHeaderBadges();
    });
  }

  // Subject Choice Toggles in Settings
  document.addEventListener('click', (e) => {
    const choice = e.target.closest('#settings-subjects-grid .subject-choice-card');
    if (!choice) return;
    choice.classList.toggle('selected');
  });

  // Settings Login / Register / Logout Buttons
  const settingsLoginBtn = document.getElementById('settings-login-btn');
  if (settingsLoginBtn) {
    settingsLoginBtn.addEventListener('click', () => openAuthModal('login'));
  }

  const settingsRegisterBtn = document.getElementById('settings-register-btn');
  if (settingsRegisterBtn) {
    settingsRegisterBtn.addEventListener('click', () => openAuthModal('register'));
  }

  const settingsLogoutBtn = document.getElementById('settings-logout-btn');
  if (settingsLogoutBtn) {
    settingsLogoutBtn.addEventListener('click', async () => {
      await logout();
      showToast('Signed out successfully.');
      AppState.currentUser = null;
      AppState.updateAuthUI();
    });
  }

  // Settings Data Clears
  const clearBmBtn = document.getElementById('settings-clear-bookmarks-btn');
  if (clearBmBtn) {
    clearBmBtn.addEventListener('click', () => {
      StorageService.setBookmarks([]);
      UIController.updateHeaderBadges();
      showToast('Bookmarks cleared.');
    });
  }

  const resetAllBtn = document.getElementById('settings-reset-all-btn');
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      if (confirm('Reset all local study progress, streak, and preferences?')) {
        StorageService.clearAllData();
        window.location.reload();
      }
    });
  }

  const exportListBtn = document.getElementById('saved-export-list-btn');
  if (exportListBtn) {
    exportListBtn.addEventListener('click', () => {
      const bookmarks = StorageService.getBookmarks();
      const items = bookmarks.map(id => FundishaData.RESOURCES.find(r => r.id === id)).filter(Boolean);
      let text = `FUNDISHA STUDY LIST — ${AppState.user.class}\n`;
      text += `Exported on: ${new Date().toLocaleDateString()}\n\n`;
      items.forEach((it, idx) => {
        text += `${idx + 1}. [${it.subject}] ${it.title}\n   Type: ${it.type} | Author: ${it.author || 'Fundisha'}\n\n`;
      });

      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Fundisha_Reading_List_${AppState.user.class}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Reading list exported to device!');
    });
  }

  setupAuthModalListeners();
  setupReportModalListeners();
  setupGlobalSearchAndSuggestions();
  setupOnboardingFlow();
}

// --------------------------------------------------------------------------
// 6. Authentication Modal Flow (Sign In / Register / Reset)
// --------------------------------------------------------------------------

function openAuthModal(tab = 'login') {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  modal.classList.add('active');

  const errorBanner = document.getElementById('auth-error-banner');
  if (errorBanner) errorBanner.style.display = 'none';

  switchAuthTab(tab);
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('active');
}

function switchAuthTab(tab) {
  const loginTab = document.getElementById('auth-tab-login');
  const regTab = document.getElementById('auth-tab-register');
  const loginForm = document.getElementById('auth-login-form');
  const regForm = document.getElementById('auth-register-form');
  const resetForm = document.getElementById('auth-reset-form');

  if (tab === 'login') {
    if (loginTab) loginTab.className = 'btn btn-sm btn-primary';
    if (regTab) regTab.className = 'btn btn-sm btn-secondary';
    if (loginForm) loginForm.style.display = 'block';
    if (regForm) regForm.style.display = 'none';
    if (resetForm) resetForm.style.display = 'none';
  } else if (tab === 'register') {
    if (loginTab) loginTab.className = 'btn btn-sm btn-secondary';
    if (regTab) regTab.className = 'btn btn-sm btn-primary';
    if (loginForm) loginForm.style.display = 'none';
    if (regForm) regForm.style.display = 'block';
    if (resetForm) resetForm.style.display = 'none';
  } else if (tab === 'reset') {
    if (loginForm) loginForm.style.display = 'none';
    if (regForm) regForm.style.display = 'none';
    if (resetForm) resetForm.style.display = 'block';
  }
}

function setupAuthModalListeners() {
  const closeBtn = document.getElementById('auth-modal-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeAuthModal);

  const loginTab = document.getElementById('auth-tab-login');
  if (loginTab) loginTab.addEventListener('click', () => switchAuthTab('login'));

  const regTab = document.getElementById('auth-tab-register');
  if (regTab) regTab.addEventListener('click', () => switchAuthTab('register'));

  const showResetBtn = document.getElementById('auth-show-reset-btn');
  if (showResetBtn) showResetBtn.addEventListener('click', () => switchAuthTab('reset'));

  const backToLoginBtn = document.getElementById('auth-back-to-login-btn');
  if (backToLoginBtn) backToLoginBtn.addEventListener('click', () => switchAuthTab('login'));

  // Login Form Submission
  const loginForm = document.getElementById('auth-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-login-email').value;
      const password = document.getElementById('auth-login-password').value;
      const errorBanner = document.getElementById('auth-error-banner');
      const submitBtn = document.getElementById('auth-login-submit-btn');

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in...';
        await loginWithEmail(email, password);
        closeAuthModal();
        showToast('Signed in successfully! Progress synced to cloud.');
      } catch (err) {
        if (errorBanner) {
          errorBanner.textContent = err.message || 'Unable to sign in. Please verify your credentials.';
          errorBanner.style.display = 'block';
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
    });
  }

  // Register Form Submission
  const regForm = document.getElementById('auth-register-form');
  if (regForm) {
    regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('auth-reg-name').value;
      const email = document.getElementById('auth-reg-email').value;
      const password = document.getElementById('auth-reg-password').value;
      const cls = document.getElementById('auth-reg-class').value;
      const errorBanner = document.getElementById('auth-error-banner');
      const submitBtn = document.getElementById('auth-reg-submit-btn');

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating account...';
        await registerWithEmail(email, password, { name, class: cls });
        closeAuthModal();
        showToast('Account created! Welcome to Fundisha.');
      } catch (err) {
        if (errorBanner) {
          errorBanner.textContent = err.message || 'Registration failed. Please check your details.';
          errorBanner.style.display = 'block';
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Free Account';
      }
    });
  }

  // Password Reset Form Submission
  const resetForm = document.getElementById('auth-reset-form');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-reset-email').value;
      const errorBanner = document.getElementById('auth-error-banner');
      const submitBtn = document.getElementById('auth-reset-submit-btn');

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending link...';
        await resetPassword(email);
        showToast('Password reset link sent to your email.');
        switchAuthTab('login');
      } catch (err) {
        if (errorBanner) {
          errorBanner.textContent = err.message || 'Could not send reset email.';
          errorBanner.style.display = 'block';
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Reset Link';
      }
    });
  }
}

// --------------------------------------------------------------------------
// 7. Resource Report Modal Flow
// --------------------------------------------------------------------------

function openReportModal(resource) {
  const modal = document.getElementById('report-modal');
  if (!modal) return;
  modal.classList.add('active');

  document.getElementById('report-resource-id').value = resource.id;
  document.getElementById('report-resource-name').textContent = `Resource: "${resource.title}" (${resource.subject} • ${resource.class})`;
}

function closeReportModal() {
  const modal = document.getElementById('report-modal');
  if (modal) modal.classList.remove('active');
}

function setupReportModalListeners() {
  const closeBtn = document.getElementById('report-modal-close-btn');
  const cancelBtn = document.getElementById('report-cancel-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeReportModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeReportModal);

  const form = document.getElementById('report-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const resourceId = document.getElementById('report-resource-id').value;
      const reason = document.getElementById('report-reason-select').value;
      const description = document.getElementById('report-description-input').value;
      const submitBtn = document.getElementById('report-submit-btn');

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';

        await submitResourceReport(
          resourceId,
          AppState.currentUser ? AppState.currentUser.uid : 'guest',
          reason,
          description
        );

        closeReportModal();
        showToast('Report submitted. Thank you for improving Fundisha!');
        form.reset();
      } catch (err) {
        showToast('Could not submit report right now.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
      }
    });
  }
}

// --------------------------------------------------------------------------
// 8. Educational Search Suggestions Engine & Quick Search Modal
// --------------------------------------------------------------------------

function getEducationalSuggestions(rawQuery) {
  const query = (rawQuery || '').trim().toLowerCase();
  if (!query) return [];

  const results = [];
  const addedKeys = new Set();

  // 1. Check Subjects
  FundishaData.SUBJECTS.forEach(sub => {
    if (sub.name.toLowerCase().includes(query)) {
      const key = `subj-${sub.name}`;
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        results.push({
          type: 'Subject',
          title: sub.name,
          subtitle: `${sub.count || 24}+ curriculum materials`,
          icon: sub.icon || 'book-open',
          action: 'subject',
          value: sub.name
        });
      }
    }
  });

  // 2. Check Resource Types & Formats
  FundishaData.RESOURCE_TYPES.forEach(t => {
    if (t.label.toLowerCase().includes(query) || t.id.toLowerCase().includes(query)) {
      const key = `type-${t.id}`;
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        results.push({
          type: 'Format',
          title: t.label,
          subtitle: `Browse all ${t.label.toLowerCase()}`,
          icon: t.icon || 'file-text',
          action: 'format',
          value: t.id
        });
      }
    }
  });

  // 3. Check Resources (Titles, Topics, Syllabus, Years)
  FundishaData.RESOURCES.forEach(r => {
    const titleMatch = r.title.toLowerCase().includes(query);
    const topicMatch = (r.topic || '').toLowerCase().includes(query);
    const descMatch = (r.description || '').toLowerCase().includes(query);
    const yearMatch = (r.dateAdded || '').includes(query) || r.title.includes(query);

    if (titleMatch || topicMatch || descMatch || yearMatch) {
      const key = `res-${r.id}`;
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        results.push({
          type: r.type || 'Resource',
          title: r.title,
          subtitle: `${r.subject} • ${r.class} • ${r.author || 'Fundisha'}`,
          icon: 'file-text',
          action: 'resource',
          id: r.id,
          subject: r.subject,
          class: r.class
        });
      }
    }
  });

  return results.slice(0, 8);
}

function highlightMatchText(text, query) {
  if (!query || !text) return escapeHTML(text);
  const q = query.trim();
  if (!q) return escapeHTML(text);

  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escapeHTML(text).replace(regex, '<mark style="background:rgba(29, 78, 216, 0.15); color:var(--brand-primary); padding:0 2px; border-radius:2px; font-weight:700;">$1</mark>');
}

function setupGlobalSearchAndSuggestions() {
  // --- A. HERO SEARCH BAR & DROPDOWN ---
  const heroForm = document.getElementById('hero-search-form');
  const heroInput = document.getElementById('hero-search-input');
  const heroClear = document.getElementById('hero-search-clear');
  const heroSuggestions = document.getElementById('hero-search-suggestions');

  let heroDebounceTimer = null;

  function updateHeroSuggestions() {
    if (!heroInput || !heroSuggestions) return;
    const query = heroInput.value.trim();

    if (heroClear) {
      heroClear.style.display = query ? 'flex' : 'none';
    }

    if (!query) {
      heroSuggestions.style.display = 'none';
      heroSuggestions.innerHTML = '';
      return;
    }

    const suggestions = getEducationalSuggestions(query);
    if (suggestions.length === 0) {
      heroSuggestions.innerHTML = `
        <div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.875rem;">
          No direct syllabus match for "<strong>${escapeHTML(query)}</strong>". Press Enter to search all archives.
        </div>
      `;
      heroSuggestions.style.display = 'block';
      return;
    }

    heroSuggestions.innerHTML = suggestions.map((item, idx) => `
      <div class="suggestion-item" data-suggestion-idx="${idx}" data-action-type="${item.action}" data-action-val="${escapeHTML(item.value || '')}" data-resource-id="${item.id || ''}" data-subject="${escapeHTML(item.subject || '')}">
        <div class="suggestion-item-main">
          <span class="suggestion-item-icon">${getLucideIconSvg(item.icon || 'file-text', 16)}</span>
          <div style="min-width: 0;">
            <div class="suggestion-item-text">${highlightMatchText(item.title, query)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 2px;">${escapeHTML(item.subtitle)}</div>
          </div>
        </div>
        <span class="suggestion-item-badge">${escapeHTML(item.type)}</span>
      </div>
    `).join('');

    heroSuggestions.style.display = 'block';
  }

  if (heroInput) {
    heroInput.addEventListener('input', () => {
      clearTimeout(heroDebounceTimer);
      heroDebounceTimer = setTimeout(updateHeroSuggestions, 120);
    });

    heroInput.addEventListener('focus', () => {
      if (heroInput.value.trim()) updateHeroSuggestions();
    });

    heroInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (heroSuggestions) heroSuggestions.style.display = 'none';
      }
    });
  }

  if (heroClear) {
    heroClear.addEventListener('click', (e) => {
      e.preventDefault();
      if (heroInput) {
        heroInput.value = '';
        heroInput.focus();
      }
      if (heroSuggestions) {
        heroSuggestions.style.display = 'none';
        heroSuggestions.innerHTML = '';
      }
      heroClear.style.display = 'none';
    });
  }

  if (heroForm) {
    heroForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (heroInput ? heroInput.value.trim() : '');
      if (heroSuggestions) heroSuggestions.style.display = 'none';
      AppState.activeFilters.search = q;
      UIController.navigate('resources');
    });
  }

  // Handle Hero Suggestion Clicks
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item && heroSuggestions && heroSuggestions.contains(item)) {
      const actionType = item.dataset.actionType;
      heroSuggestions.style.display = 'none';

      if (actionType === 'subject') {
        UIController.navigate('subject-detail', { subject: item.dataset.actionVal });
      } else if (actionType === 'format') {
        UIController.navigate('resources', { type: item.dataset.actionVal });
      } else if (actionType === 'resource') {
        UIController.navigate('resource-detail', { id: item.dataset.resourceId });
      }
      return;
    }

    if (heroSuggestions && !heroSuggestions.contains(e.target) && e.target !== heroInput) {
      heroSuggestions.style.display = 'none';
    }
  });

  // --- B. QUICK SEARCH MODAL ---
  const modal = document.getElementById('search-modal');
  const modalClose = document.getElementById('search-modal-close-btn');
  const modalInput = document.getElementById('quick-search-modal-input');
  const modalClear = document.getElementById('modal-search-clear');
  const modalResults = document.getElementById('quick-search-modal-results');

  function openQuickSearch() {
    if (!modal) return;
    modal.classList.add('active');
    if (modalInput) {
      modalInput.value = '';
      modalInput.focus();
      renderModalSearchResults('');
    }
  }

  function closeQuickSearch() {
    if (modal) modal.classList.remove('active');
  }

  // Triggers
  const headerTrigger = document.getElementById('header-search-trigger');
  if (headerTrigger) headerTrigger.addEventListener('click', openQuickSearch);

  const genericTriggers = document.querySelectorAll('[data-action="open-search"], #search-modal-trigger');
  genericTriggers.forEach(t => t.addEventListener('click', openQuickSearch));

  if (modalClose) modalClose.addEventListener('click', closeQuickSearch);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeQuickSearch();
    });
  }

  // Global Keyboard Shortcut: Cmd/Ctrl + K or "/"
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openQuickSearch();
    } else if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      openQuickSearch();
    } else if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
      closeQuickSearch();
    }
  });

  function renderModalSearchResults(rawQuery) {
    if (!modalResults) return;
    const query = (rawQuery || '').trim();

    if (modalClear) {
      modalClear.style.display = query ? 'block' : 'none';
    }

    const suggestions = getEducationalSuggestions(query);
    if (suggestions.length === 0) {
      modalResults.innerHTML = `
        <div style="padding: 2rem 1rem; text-align: center; color: var(--text-muted);">
          <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem;">No matching curriculum materials found</div>
          <div style="font-size: 0.85rem;">Try searching for subjects like "Mathematics", "Physics", or formats like "Past Papers".</div>
        </div>
      `;
      return;
    }

    modalResults.innerHTML = suggestions.map(item => `
      <div class="search-result-item" style="padding: 0.85rem 1rem; border-radius: var(--radius-lg); background: var(--bg-surface); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: all var(--transition-fast);" 
           data-modal-action="${item.action}" data-val="${escapeHTML(item.value || '')}" data-id="${item.id || ''}">
        <div style="display: flex; align-items: center; gap: 0.75rem; min-width: 0;">
          <div style="width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--brand-primary-light); color: var(--brand-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            ${getLucideIconSvg(item.icon || 'file-text', 16)}
          </div>
          <div style="min-width: 0;">
            <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${highlightMatchText(item.title, query)}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
              ${escapeHTML(item.subtitle)}
            </div>
          </div>
        </div>
        <span style="font-size: 0.825rem; color: var(--brand-primary); font-weight: 700; display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0;">
          Select →
        </span>
      </div>
    `).join('');
  }

  if (modalInput) {
    modalInput.addEventListener('input', (e) => {
      renderModalSearchResults(e.target.value);
    });
  }

  if (modalClear) {
    modalClear.addEventListener('click', () => {
      if (modalInput) {
        modalInput.value = '';
        modalInput.focus();
        renderModalSearchResults('');
      }
    });
  }

  // Handle Modal Result Clicks
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result-item[data-modal-action]');
    if (!item) return;

    closeQuickSearch();
    const action = item.dataset.modalAction;
    if (action === 'subject') {
      UIController.navigate('subject-detail', { subject: item.dataset.val });
    } else if (action === 'format') {
      UIController.navigate('resources', { type: item.dataset.val });
    } else if (action === 'resource') {
      UIController.navigate('resource-detail', { id: item.dataset.id });
    }
  });

  // --- C. CONTACT FORM SUBMISSION ---
  const contactForm = document.getElementById('contact-page-form');
  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('contact-name').value;
      const email = document.getElementById('contact-email').value;
      const subject = document.getElementById('contact-subject').value;
      const message = document.getElementById('contact-message').value;

      if (!name || !email || !message) {
        showToast('Please fill in all required fields.', '⚠️');
        return;
      }

      showToast(`Thank you, ${name}! Your inquiry has been sent to the Fundisha team.`, '📬');
      contactForm.reset();
    });
  }
}

// --------------------------------------------------------------------------
// 9. First-Time Onboarding Flow Setup
// --------------------------------------------------------------------------

function setupOnboardingFlow() {
  const modal = document.getElementById('onboarding-modal');
  if (!modal) return;

  const profile = StorageService.getProfile();
  if (profile && profile.isOnboarded) {
    modal.classList.remove('active');
    return;
  }

  modal.classList.add('active');

  let chosenClass = 'Senior 5';
  let chosenSubjects = ['Mathematics', 'Physics', 'Chemistry', 'ICT'];

  document.querySelectorAll('#onboarding-class-grid .class-choice-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#onboarding-class-grid .class-choice-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      chosenClass = card.dataset.class;
    });
  });

  const step1Btn = document.getElementById('onboarding-step1-btn');
  const step1 = document.getElementById('onboarding-step-1');
  const step2 = document.getElementById('onboarding-step-2');
  const subjectsGrid = document.getElementById('onboarding-subjects-grid');

  if (step1Btn && subjectsGrid) {
    step1Btn.addEventListener('click', () => {
      step1.style.display = 'none';
      step2.style.display = 'block';

      subjectsGrid.innerHTML = FundishaData.SUBJECTS.map(s => {
        const isSelected = chosenSubjects.includes(s.name);
        return `
          <div class="subject-choice-card ${isSelected ? 'selected' : ''}" data-subject-val="${s.name}">
            <span style="display:inline-flex; align-items:center; gap:0.5rem;">${getLucideIconSvg(s.icon, 16)} <span>${s.name}</span></span>
          </div>
        `;
      }).join('');
    });
  }

  document.addEventListener('click', (e) => {
    const card = e.target.closest('#onboarding-subjects-grid .subject-choice-card');
    if (!card) return;
    card.classList.toggle('selected');
  });

  const backBtn = document.getElementById('onboarding-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      step2.style.display = 'none';
      step1.style.display = 'block';
    });
  }

  const finishBtn = document.getElementById('onboarding-finish-btn');
  if (finishBtn) {
    finishBtn.addEventListener('click', async () => {
      const selected = [];
      document.querySelectorAll('#onboarding-subjects-grid .subject-choice-card.selected').forEach(c => {
        selected.push(c.dataset.subjectVal);
      });

      AppState.user.class = chosenClass;
      AppState.user.subjects = selected.length > 0 ? selected : ['Mathematics', 'Physics', 'Chemistry'];
      AppState.user.isOnboarded = true;
      StorageService.saveProfile(AppState.user);

      if (AppState.currentUser) {
        await updateUserProfile(AppState.currentUser.uid, {
          class: AppState.user.class,
          subjects: AppState.user.subjects
        });
      }

      modal.classList.remove('active');
      showToast(`Welcome to Fundisha! Personalizing for ${chosenClass}.`, '🎉');
      UIController.navigate('home');
    });
  }
}

// --------------------------------------------------------------------------
// 10. Utilities (Download Simulation, Markdown Parsing, Security)
// --------------------------------------------------------------------------

function simulateDownload(resource) {
  const content = `===========================================================
FUNDISHA — FREE UGANDA SECONDARY EDUCATIONAL ARCHIVE
===========================================================
Title:       ${resource.title}
Subject:     ${resource.subject}
Class:       ${resource.class}
Topic:       ${resource.topic}
Type:        ${resource.type}
Institution: ${resource.author || 'Fundisha'}
Added Date:  ${resource.dateAdded}
===========================================================

SUMMARY & SYLLABUS HIGHLIGHTS:
${resource.description}

CORE OBJECTIVES:
${(resource.objectives || []).map((o, i) => `${i + 1}. ${o}`).join('\n')}

-----------------------------------------------------------
This study material is provided for free academic revision 
under the Fundisha Educational Initiative for Uganda.
===========================================================`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resource.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_Fundisha.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Downloading: ${resource.title.slice(0, 30)}...`, '📥');
  StorageService.addPoints(15);
}

function formatMarkdownToHTML(markdown) {
  return markdown
    .replace(/^### (.*$)/gim, '<h4 style="font-size:1rem; font-weight:700; color:var(--brand-primary); margin:0.75rem 0 0.25rem 0;">$1</h4>')
    .replace(/^## (.*$)/gim, '<h3 style="font-size:1.1rem; font-weight:800; margin:0.85rem 0 0.35rem 0;">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^\* (.*$)/gim, '• $1<br>')
    .replace(/\n\n/g, '<br><br>');
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// --------------------------------------------------------------------------
// 11. Application Initialization Bootstrapper
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  AppState.init();
  setupEventListeners();

  const initialHash = window.location.hash.slice(1) || 'home';
  const [view, queryStr] = initialHash.split('?');
  const params = {};
  if (queryStr) {
    const urlParams = new URLSearchParams(queryStr);
    for (const [k, v] of urlParams.entries()) params[k] = v;
  }
  UIController.navigate(view, params);
});
