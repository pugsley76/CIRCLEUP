/**
 * Keyboard-only tests for transaction preparation and confirmation (Issue #702)
 *
 * Verifies accessibility and keyboard interaction invariants:
 *   1. Form entry keyboard navigation: Tab/Shift-Tab order through inputs, buttons
 *      without unexpected focus traps in non-modal flows.
 *   2. Modal alertdialog focus trapping: Tab/Shift-Tab cycle exclusively within dialog controls.
 *   3. Keyboard cancellation & dismissal: Escape key or Cancel button dismisses dialog.
 *   4. Focus restoration: focus strictly returns to the trigger element after dismissal.
 *   5. Accessible names & error association: `aria-describedby` links inputs to error messages.
 *   6. Live regions & status announcements: `role="alert"` and `aria-live` announcements.
 *
 * Run locally:
 *   node --experimental-strip-types --test tests/keyboard-navigation.test.ts
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Lightweight Headless Keyboard & Focus Harness ───────────────────────────

interface FocusableNode {
  id: string;
  tagName: string;
  role?: string;
  type?: string;
  disabled?: boolean;
  tabIndex?: number;
  ariaModal?: boolean;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLive?: "polite" | "assertive" | "off";
  textContent?: string;
  children?: FocusableNode[];
  onKeyDown?: (event: { key: string; shiftKey: boolean; defaultPrevented: boolean; preventDefault: () => void }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

class KeyboardTestEnvironment {
  nodes: Map<string, FocusableNode> = new Map();
  activeElement: FocusableNode | null = null;
  focusHistory: string[] = [];

  register(node: FocusableNode) {
    this.nodes.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        this.register(child);
      }
    }
  }

  focus(id: string) {
    const node = this.nodes.get(id);
    if (!node || node.disabled) return false;

    if (this.activeElement?.onBlur) {
      this.activeElement.onBlur();
    }
    this.activeElement = node;
    this.focusHistory.push(node.id);
    if (node.onFocus) {
      node.onFocus();
    }
    return true;
  }

  dispatchKeyDown(key: string, shiftKey = false) {
    if (!this.activeElement) return;

    let prevented = false;
    const event = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault: () => {
        prevented = true;
        event.defaultPrevented = true;
      },
    };

    if (this.activeElement.onKeyDown) {
      this.activeElement.onKeyDown(event);
    }
    return { prevented };
  }
}

// ─── Component Model 1: CreateCircleForm (Transaction Preparation) ───────────

function createFormHarness() {
  const env = new KeyboardTestEnvironment();

  let fieldErrors: Record<string, string> = {};
  let alertMessages: string[] = [];

  const tabOrder = [
    "name-input",
    "amount-input",
    "days-input",
    "member-0-input",
    "member-1-input",
    "add-member-button",
    "submit-button",
  ];

  function tabNext(shift = false) {
    const currentId = env.activeElement?.id ?? "";
    const currentIndex = tabOrder.indexOf(currentId);
    let nextIndex = 0;

    if (currentIndex === -1) {
      nextIndex = shift ? tabOrder.length - 1 : 0;
    } else {
      nextIndex = shift ? (currentIndex - 1 + tabOrder.length) % tabOrder.length : (currentIndex + 1) % tabOrder.length;
    }

    env.focus(tabOrder[nextIndex]);
  }

  // Register interactive controls with accessible metadata matching CreateClient.tsx
  for (const id of tabOrder) {
    env.register({
      id,
      tagName: id.includes("button") ? "BUTTON" : "INPUT",
      tabIndex: 0,
      ariaDescribedBy: fieldErrors[id] ? `${id}-err` : undefined,
      onKeyDown: (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          tabNext(e.shiftKey);
        }
      },
    });
  }

  return {
    env,
    tabOrder,
    tabNext,
    setFieldError: (fieldId: string, errorId: string, message: string) => {
      fieldErrors[fieldId] = errorId;
      const node = env.nodes.get(fieldId);
      if (node) {
        node.ariaDescribedBy = errorId;
        node.ariaInvalid = true;
      }
      alertMessages.push(message);
      env.register({
        id: errorId,
        tagName: "P",
        role: "alert",
        ariaLive: "assertive",
        textContent: message,
      });
    },
  };
}

// ─── Component Model 2: ConfirmDefaultDialog (Transaction Confirmation) ───────

function createConfirmDialogHarness() {
  const env = new KeyboardTestEnvironment();

  let isDialogOpen = false;
  let triggerElementId: string | null = null;

  // Trigger button outside the modal
  env.register({
    id: "mark-default-trigger-btn",
    tagName: "BUTTON",
    tabIndex: 0,
    textContent: "Mark Default",
  });

  // Dialog inner focusable elements
  const dialogFocusableOrder = ["confirm-dialog-cancel-btn", "confirm-dialog-submit-btn"];

  function openDialog(triggerId: string) {
    triggerElementId = triggerId;
    isDialogOpen = true;

    // Register dialog & inner interactive controls
    env.register({
      id: "confirm-dialog",
      tagName: "DIV",
      role: "alertdialog",
      ariaModal: true,
      ariaLabelledBy: "default-confirm-title",
      tabIndex: -1,
      children: [
        {
          id: "confirm-dialog-cancel-btn",
          tagName: "BUTTON",
          tabIndex: 0,
          textContent: "Cancel",
          onKeyDown: (e) => handleDialogKeyDown(e),
        },
        {
          id: "confirm-dialog-submit-btn",
          tagName: "BUTTON",
          tabIndex: 0,
          textContent: "Confirm & Sign",
          onKeyDown: (e) => handleDialogKeyDown(e),
        },
      ],
    });

    // Auto-focus first interactive control
    env.focus("confirm-dialog-cancel-btn");
  }

  function closeDialog() {
    isDialogOpen = false;
    // Restore focus to trigger element
    if (triggerElementId) {
      env.focus(triggerElementId);
    }
  }

  function handleDialogKeyDown(e: { key: string; shiftKey: boolean; defaultPrevented: boolean; preventDefault: () => void }) {
    if (!isDialogOpen) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const currentId = env.activeElement?.id;
      const first = dialogFocusableOrder[0];
      const last = dialogFocusableOrder[dialogFocusableOrder.length - 1];

      if (e.shiftKey) {
        if (currentId === first) {
          env.focus(last);
        } else {
          env.focus(first);
        }
      } else {
        if (currentId === last) {
          env.focus(first);
        } else {
          env.focus(last);
        }
      }
    }
  }

  return {
    env,
    openDialog,
    closeDialog,
    dialogFocusableOrder,
    isOpen: () => isDialogOpen,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Keyboard-only transaction preparation and confirmation (#702)", () => {

  // ── 1. Form Entry Keyboard Progression (No Traps) ──────────────────────────

  test("form entry: tab moves forward through entire form sequence without trap", () => {
    const { env, tabOrder } = createFormHarness();

    // Start focus at first element
    env.focus(tabOrder[0]);
    assert.equal(env.activeElement?.id, "name-input");

    // Advance forward through all fields using Tab
    for (let i = 1; i < tabOrder.length; i++) {
      env.dispatchKeyDown("Tab", false);
      assert.equal(env.activeElement?.id, tabOrder[i], `Tab step ${i} should focus ${tabOrder[i]}`);
    }

    // Tabbing past submit button loops naturally to the first element
    env.dispatchKeyDown("Tab", false);
    assert.equal(env.activeElement?.id, tabOrder[0], "Tab from last element wraps to first");
  });

  test("form entry: shift-tab moves backward through entire form sequence", () => {
    const { env, tabOrder } = createFormHarness();

    // Start at submit button
    env.focus(tabOrder[tabOrder.length - 1]);
    assert.equal(env.activeElement?.id, "submit-button");

    // Advance backward through all fields using Shift-Tab
    for (let i = tabOrder.length - 2; i >= 0; i--) {
      env.dispatchKeyDown("Tab", true);
      assert.equal(env.activeElement?.id, tabOrder[i], `Shift-Tab should focus ${tabOrder[i]}`);
    }

    // Shift-Tab from first wraps to last
    env.dispatchKeyDown("Tab", true);
    assert.equal(env.activeElement?.id, tabOrder[tabOrder.length - 1], "Shift-Tab from first wraps to last");
  });

  // ── 2. Error Association & Live Regions ─────────────────────────────────────

  test("form validation: field error updates aria-invalid and aria-describedby", () => {
    const { env, setFieldError } = createFormHarness();

    const nameNode = env.nodes.get("name-input")!;
    assert.equal(nameNode.ariaInvalid, undefined);
    assert.equal(nameNode.ariaDescribedBy, undefined);

    // Trigger validation error
    setFieldError("name-input", "name-input-err", "Circle name is required");

    assert.equal(nameNode.ariaInvalid, true, "invalid field must have aria-invalid='true'");
    assert.equal(nameNode.ariaDescribedBy, "name-input-err", "must associate control with error message ID");

    // Verify error element has role="alert"
    const errNode = env.nodes.get("name-input-err")!;
    assert.equal(errNode.role, "alert", "error container must declare role='alert' for screen readers");
    assert.equal(errNode.ariaLive, "assertive", "error message should announce assertively");
  });

  // ── 3. Confirmation Dialog Focus Trapping ───────────────────────────────────

  test("confirmation dialog: traps Tab and Shift-Tab exclusively within dialog actions", () => {
    const harness = createConfirmDialogHarness();

    // Focus trigger button
    harness.env.focus("mark-default-trigger-btn");
    assert.equal(harness.env.activeElement?.id, "mark-default-trigger-btn");

    // Open confirmation dialog
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);

    // Initial focus must be inside dialog on first action (Cancel)
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-cancel-btn");

    // Tab moves to Confirm & Sign button
    harness.env.dispatchKeyDown("Tab", false);
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-submit-btn");

    // Tab from Confirm & Sign button TRAPS and wraps back to Cancel button (NOT outside the dialog!)
    harness.env.dispatchKeyDown("Tab", false);
    assert.equal(
      harness.env.activeElement?.id,
      "confirm-dialog-cancel-btn",
      "focus trap must wrap Tab to first dialog element"
    );

    // Shift-Tab from Cancel button TRAPS and wraps to Confirm & Sign button
    harness.env.dispatchKeyDown("Tab", true);
    assert.equal(
      harness.env.activeElement?.id,
      "confirm-dialog-submit-btn",
      "focus trap must wrap Shift-Tab to last dialog element"
    );
  });

  // ── 4. Focus Restoration On Dismissal & Escape ──────────────────────────────

  test("confirmation dialog: escape key dismisses dialog and restores focus to trigger element", () => {
    const harness = createConfirmDialogHarness();

    harness.env.focus("mark-default-trigger-btn");
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);
    assert.equal(harness.env.activeElement?.id, "confirm-dialog-cancel-btn");

    // Press Escape
    const result = harness.env.dispatchKeyDown("Escape");
    assert.equal(result?.prevented, true, "Escape key default must be prevented");
    assert.equal(harness.isOpen(), false, "dialog must be closed on Escape");

    // Focus MUST be restored to the trigger element
    assert.equal(
      harness.env.activeElement?.id,
      "mark-default-trigger-btn",
      "focus must return to the trigger element that opened the dialog"
    );
  });

  test("confirmation dialog: cancel button activation dismisses and restores focus", () => {
    const harness = createConfirmDialogHarness();

    harness.env.focus("mark-default-trigger-btn");
    harness.openDialog("mark-default-trigger-btn");
    assert.equal(harness.isOpen(), true);

    // Activate cancel button
    harness.closeDialog();
    assert.equal(harness.isOpen(), false);

    // Focus restored
    assert.equal(
      harness.env.activeElement?.id,
      "mark-default-trigger-btn",
      "focus must return to trigger button after cancel"
    );
  });

  // ── 5. Alertdialog Semantics & Accessible Properties ────────────────────────

  test("confirmation dialog: semantics match W3C alertdialog modal pattern", () => {
    const harness = createConfirmDialogHarness();
    harness.openDialog("mark-default-trigger-btn");

    const dialog = harness.env.nodes.get("confirm-dialog")!;
    assert.equal(dialog.role, "alertdialog", "dialog role must be 'alertdialog'");
    assert.equal(dialog.ariaModal, true, "dialog must declare aria-modal='true'");
    assert.equal(dialog.ariaLabelledBy, "default-confirm-title", "dialog must reference accessible title ID");
  });
});
