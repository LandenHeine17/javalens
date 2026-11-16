plugins {
    // Lets Gradle download a matching JDK (Eclipse Temurin) when one isn't installed.
    // Used for packaging, so local installers are built the same way as the GitHub ones.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "javalens"
