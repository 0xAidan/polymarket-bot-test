/**
 * Client-side Conflict Detection
 * Validates configuration combinations and detects potential issues
 */

const ConflictDetector = {
  // Run all conflict checks
  async checkConflicts() {
    try {
      // Fetch validation from server (has full context)
      const result = await API.validateConfig();
      return result;
    } catch (error) {
      console.error('Error checking conflicts:', error);
      return { valid: true, conflicts: [], errorCount: 0, warningCount: 0 };
    }
  },

  // Display conflicts in the UI
  displayConflicts(conflicts) {
    const banner = document.getElementById('conflictBanner');
    const panel = document.getElementById('conflictPanel');
    const list = document.getElementById('conflictsList');
    
    if (!conflicts || conflicts.length === 0) {
      banner.style.display = 'none';
      panel.style.display = 'none';
      return;
    }

    // Update banner
    const errorCount = conflicts.filter(c => c.type === 'error').length;
    const warningCount = conflicts.filter(c => c.type === 'warning').length;
    
    let message = '';
    if (errorCount > 0) {
      message += `${errorCount} error(s)`;
    }
    if (warningCount > 0) {
      message += errorCount > 0 ? ` and ${warningCount} warning(s)` : `${warningCount} warning(s)`;
    }
    
    document.getElementById('conflictMessage').textContent = `Configuration issues: ${message}`;
    banner.style.display = 'flex';
    
    // Update panel
    panel.style.display = 'block';
    list.innerHTML = conflicts.map(c => `
      <div class="conflict-item ${c.type}">
        <div class="conflict-item-icon">${c.type === 'error' ? '&#10060;' : '&#9888;'}</div>
        <div class="conflict-item-content">
          <div class="conflict-item-message">${c.message}</div>
          ${c.suggestion ? `<div class="conflict-item-suggestion">Suggestion: ${c.suggestion}</div>` : ''}
        </div>
      </div>
    `).join('');
  },

  // Refresh conflict display
  async refreshConflictDisplay() {
    const result = await this.checkConflicts();
    this.displayConflicts(result.conflicts || []);
    return result;
  }
};

// Make available globally
window.ConflictDetector = ConflictDetector;
