// instrumentation/android/appmap/build.gradle.kts — app-map instrumentation library (01 §2, R3–R7).
//
// Include it from the app's settings.gradle.kts:
//   include(":appmap")
//   project(":appmap").projectDir = file("../instrumentation/android/appmap")   // adjust the path
// Plugin versions come from the root build (AGP 8.x, Kotlin 2.x + the Compose compiler plugin).
//
// `BuildConfig.APP_MAP_DEBUG` gates every test-only surface (deep links, router export, fixtures);
// the debug-only manifest entries live in src/debug/AndroidManifest.xml so Release contains
// neither the deep-link intent filter nor the export receiver (01 §4).

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.example.appmap"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        // issue #25: the deep-link scheme is per app. `appmap` keeps every existing single-app
        // integration working unchanged; a repo with two instrumented apps overrides it in the
        // consuming app's debug buildType, and must set the SAME value on
        // `AppMapDeepLink.scheme` and in app-map/android/manifest.yaml `deep_link_scheme`.
        //
        //     manifestPlaceholders["appMapScheme"] = "appmap-pokedexteams"
        manifestPlaceholders["appMapScheme"] = "appmap"
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "APP_MAP_DEBUG", "true")
        }
        release {
            buildConfigField("boolean", "APP_MAP_DEBUG", "false")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Plain JVM unit tests (src/test). android.jar stubs return defaults instead of throwing.
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
