import type {
  FileBuild,
  ProductSpec,
  TestPlan,
} from "../../shared/schemas.js";

const UI_SOURCE = /\.(?:jsx|tsx|vue|svelte|html)$/i;
const TEST_PATH =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)test_[^/]+\.py$|_test\.py$/i;
const ACTIVE_TEST = /\b(?:it|test)\s*\(\s*["'`][^"'`]+["'`]\s*,/;
const ASSERTION = /\b(?:expect|assert(?:Equal|True|False|StrictEqual)?|assert\.)\s*\(/;
const INTERACTION =
  /\b(?:click|dblclick|fill|press|type|selectOption|check|uncheck|dragTo|dispatchEvent)\s*\(/;
const UI_ACTION =
  /\b(?:click|tap|type|fill|submit|select|open|close|navigate|route|modal|form|button|link|save|edit|delete|reload|refresh|persist|visible|render|display|responsive|keyboard|focus|drag|drop)\b/i;
const RELOAD = /\b(?:reload|refresh|persist|persistence)\b/i;

export interface GeneratedTestAssessment {
  ok: boolean;
  errors: string[];
  uiAcceptanceRequired: boolean;
  browserTestPaths: string[];
}

/**
 * Deterministic minimum quality contract for model-authored tests.
 *
 * This does not claim semantic correctness. It prevents vacuous/skipped tests
 * and requires an actual Playwright journey when the change touches interactive
 * UI behavior. The runner later executes every returned path directly.
 */
export function assessGeneratedTests(
  spec: ProductSpec,
  productBuild: FileBuild,
  testPlan: TestPlan,
): GeneratedTestAssessment {
  const errors: string[] = [];
  const productUiChanged = productBuild.files.some(
    (file) => UI_SOURCE.test(file.path) && !TEST_PATH.test(file.path),
  );
  const requirementText = [
    ...spec.userFlows,
    ...spec.acceptanceCriteria,
  ].join("\n");
  const uiAcceptanceRequired =
    productUiChanged && UI_ACTION.test(requirementText);
  const browserTestPaths: string[] = [];

  if (!testPlan.files.length) {
    errors.push("no change-specific test files were provided");
  }

  for (const file of testPlan.files) {
    const normalized = file.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      !TEST_PATH.test(normalized)
    ) {
      errors.push(`${file.path}: path is not a supported relative test file`);
      continue;
    }
    const source = file.contents;
    if (/\b(?:it|test|describe)\.(?:skip|todo)\b/.test(source)) {
      errors.push(`${file.path}: skipped or todo tests are not acceptance evidence`);
    }
    if (!ACTIVE_TEST.test(source)) {
      errors.push(`${file.path}: no active named test was found`);
    }
    if (
      /\b(?:it|test)\s*\([^,]+,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/s.test(
        source,
      )
    ) {
      errors.push(`${file.path}: empty test callbacks are not evidence`);
    }
    if (!ASSERTION.test(source)) {
      errors.push(`${file.path}: no assertion was found`);
    }
    if (/from\s+["']@playwright\/test["']|require\(["']@playwright\/test["']\)/.test(source)) {
      browserTestPaths.push(normalized);
    }
  }

  if (uiAcceptanceRequired) {
    if (!browserTestPaths.length) {
      errors.push(
        "interactive UI acceptance requires a generated Playwright browser test",
      );
    }
    const browserSource = testPlan.files
      .filter((file) =>
        browserTestPaths.includes(
          file.path.replace(/\\/g, "/").replace(/^\.\//, ""),
        ),
      )
      .map((file) => file.contents)
      .join("\n");
    if (browserTestPaths.length && !/\bpage\.goto\s*\(/.test(browserSource)) {
      errors.push("browser acceptance must navigate to the real application");
    }
    if (browserTestPaths.length && !INTERACTION.test(browserSource)) {
      errors.push("browser acceptance must perform a real user interaction");
    }
    if (
      browserTestPaths.length &&
      RELOAD.test(requirementText) &&
      !/\bpage\.reload\s*\(/.test(browserSource)
    ) {
      errors.push("reload/persistence acceptance requires page.reload()");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    uiAcceptanceRequired,
    browserTestPaths,
  };
}
