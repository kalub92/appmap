// AppMapKit (Android) — screen markers and element identifiers (01 R3, R4).
//
// Markers ship in every build; they are invisible to users and are what UIAutomator, Maestro and
// Argent read as resource-id. Always pass generated constants (AppMapId.Screen.*, AppMapId.Element.*);
// `app-map lint-ids` rejects string literals (01 R8).
package com.example.appmap

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

/**
 * Marks a screen root with `screen.<screen_id>` and exposes testTags below it as resource ids.
 * Exactly one marker is visible per full-screen state; sheets and modals carry their own.
 *
 * ```
 * Box(Modifier.appMapScreen(AppMapId.Screen.INVOICE_LIST)) { … }
 * ```
 *
 * Open question (01 §5): verify Argent surfaces testTags as resource ids with
 * `testTagsAsResourceId`; otherwise fall back to View ids for the pilot.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun Modifier.appMapScreen(id: String): Modifier =
    semantics { testTagsAsResourceId = true }.testTag(id)

/**
 * Tags an interactive element or form label with its registry id (01 R4). List cells of the same
 * kind share one id; index disambiguates at runtime. Requires an ancestor marked with
 * [appMapScreen] so the tag is exported as a resource id.
 */
fun Modifier.appMapId(id: String): Modifier = testTag(id)

// Views: use `android:id="@+id/…"` resource ids named after the registry id (dots → underscores);
// contentDescription is not the mechanism (01 R3).
