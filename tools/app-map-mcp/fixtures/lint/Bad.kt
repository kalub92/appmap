// fixtures/lint/Bad.kt — lint-ids fixture (01 R8). Every violation is deliberate.
package com.example.app.invoices

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.example.appmap.AppMapId

@Composable
fun InvoiceListScreen() {
  Box(Modifier.testTag("screen.invoice_list")) {                   // string_literal_id (must be AppMapId.Screen.INVOICE_LIST)
    Box(Modifier.testTag(AppMapId.Element.INVOICE_ADD_BUTTON))      // ok: generated constant
    Box(Modifier.testTag("invoice.save.button"))                     // string_literal_id
  }
}

// AppMapId.Screen.LOGIN is never referenced here: marker_unreferenced for login on android when
// this file is the only Android source scanned.
