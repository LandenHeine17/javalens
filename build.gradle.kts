import org.gradle.api.tasks.testing.logging.TestExceptionFormat

/*
 * JavaLens build.
 *
 *   ./gradlew run          dev server on :7070 (pair it with `npm run dev` in web/)
 *   ./gradlew test         run the tests
 *   ./gradlew jar          build/libs/javalens.jar  (needs a JDK to run: java -jar javalens.jar)
 *   ./gradlew installer    native installer for this OS in build/dist  (msi / dmg / deb / rpm)
 *   ./gradlew portable     unzip-and-run version for this OS in build/dist
 *   ./gradlew vscodeExtension   VS Code extension (.vsix) in build/dist  (uses the JDK the user has)
 */

plugins {
    java
    application
}

group = "javalens"

val osName = System.getProperty("os.name").lowercase()
val isWindows = osName.contains("win")
val isMac = osName.contains("mac")

java {
    toolchain { languageVersion = JavaLanguageVersion.of(25) }
}

// The Java code lives in server/ next to the web/ page, rather than Gradle's default src/.
sourceSets {
    main {
        java.setSrcDirs(listOf("server/src/main/java"))
        resources.setSrcDirs(listOf("server/src/main/resources"))
    }
    test {
        java.setSrcDirs(listOf("server/src/test/java"))
        resources.setSrcDirs(listOf("server/src/test/resources"))
    }
}

repositories { mavenCentral() }

dependencies {
    implementation("com.formdev:flatlaf:3.5.4") // modern look for the small control window
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application { mainClass = "javalens.Main" }

tasks.withType<JavaCompile>().configureEach { options.encoding = "UTF-8" }

tasks.named<JavaExec>("run") {
    args("--dev") // fixed port 7070 for the Vite dev server; no window, no browser
}

tasks.test {
    dependsOn("webTest") // the web page's unit tests (web/test) run with the Java ones
    useJUnitPlatform()
    workingDir = rootDir // the tests run the programs in samples/
    // A temp folder with a space in its name, like many Windows user folders ("C:\Users\Jo Smith"),
    // so every test also checks that paths with spaces work.
    val spacedTmp = layout.buildDirectory.dir("tmp/test temp")
    doFirst { spacedTmp.get().asFile.mkdirs() }
    systemProperty("java.io.tmpdir", spacedTmp.get().asFile.absolutePath)
    testLogging {
        events("failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
}

// ---------------------------------------------------------------- version info baked into the app

val updateRepo = providers.gradleProperty("updateRepo").orElse("")
val writeVersion = tasks.register("writeVersion") {
    description = "Writes version.properties (version + update repo) for the app to read"
    val out = layout.buildDirectory.dir("generated/version")
    val ver = project.version.toString()
    inputs.property("version", ver)
    inputs.property("updateRepo", updateRepo)
    outputs.dir(out)
    doLast {
        val file = out.get().file("javalens/version.properties").asFile
        file.parentFile.mkdirs()
        file.writeText("version=$ver\nupdateRepo=${updateRepo.get()}\n")
    }
}
sourceSets.main { resources.srcDir(writeVersion) }

// ---------------------------------------------------------------- the web page (web/, built by Vite)

val npm = if (isWindows) "npm.cmd" else "npm"

val npmInstall = tasks.register<Exec>("npmInstall") {
    description = "Installs the web page's npm packages"
    workingDir = file("web")
    commandLine(npm, "ci", "--no-audit", "--no-fund")
    inputs.file("web/package-lock.json")
    outputs.file("web/node_modules/.package-lock.json") // npm writes this; much cheaper to check than all of node_modules
}

val buildWeb = tasks.register<Exec>("buildWeb") {
    description = "Builds the web page into web/dist"
    dependsOn(npmInstall)
    workingDir = file("web")
    commandLine(npm, "run", "build")
    inputs.dir("web/src")
    inputs.dir("samples")
    inputs.files(fileTree("web/public"))
    inputs.files("web/index.html", "web/package.json", "web/vite.config.ts", "web/tsconfig.json")
    outputs.dir("web/dist")
}

// Node's built-in test runner runs the .ts tests directly (Node 22.18+ strips the types), so no test
// library is needed. They only import type-only modules, so npm install isn't needed either.
val webTest = tasks.register<Exec>("webTest") {
    description = "Runs the web page's unit tests (web/test)"
    workingDir = file("web")
    commandLine("node", "--test", "test/**/*.test.ts")
    inputs.dir("web/src")
    inputs.dir("web/test")
    outputs.upToDateWhen { false }
}

// One self-contained jar: our classes + FlatLaf + the built web page (served from inside the jar).
tasks.jar {
    archiveFileName = "javalens.jar"
    manifest { attributes("Main-Class" to "javalens.Main", "Implementation-Version" to project.version) }
    from(buildWeb) { into("web") }
    from(configurations.runtimeClasspath.map { jars -> jars.map { zipTree(it) } }) {
        exclude("META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "META-INF/MANIFEST.MF")
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

// ---------------------------------------------------------------- packaging: bundled Java + installers

// Packaging uses Eclipse Temurin (downloaded automatically if needed): it supports jlink on every OS,
// unlike some Linux distributions' JDKs, and it is what the GitHub release builds use.
val packagingJdk = javaToolchains.launcherFor {
    languageVersion = JavaLanguageVersion.of(25)
    vendor = JvmVendorSpec.ADOPTIUM
}.map { it.metadata.installationPath.asFile }

fun jdkTool(name: String): String =
    packagingJdk.get().resolve("bin/$name" + if (isWindows) ".exe" else "").absolutePath

// What the bundled Java contains: the full standard library (students' programs may use any of it),
// the compiler (running and autocomplete), the debugger (tracing), and the small HTTP server.
val runtimeModules = listOf(
    "java.se", "jdk.compiler", "jdk.jdi", "jdk.jdwp.agent", "jdk.httpserver",
    "jdk.zipfs", "jdk.charsets", "jdk.accessibility", "jdk.unsupported",
)

val jlinkRuntime = tasks.register<Exec>("jlinkRuntime") {
    description = "Builds the trimmed Java runtime that ships inside the app"
    val out = layout.buildDirectory.dir("runtime")
    inputs.property("modules", runtimeModules)
    outputs.dir(out)
    doFirst {
        delete(out)
        commandLine(
            jdkTool("jlink"),
            "--add-modules", runtimeModules.joinToString(","),
            "--strip-debug", "--no-header-files", "--no-man-pages", "--compress=zip-6",
            "--output", out.get().asFile.absolutePath,
        )
    }
}

val icons = tasks.register<JavaExec>("icons") {
    description = "Draws the app icons (png / ico / icns)"
    val out = layout.buildDirectory.dir("icons")
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass = "javalens.tools.IconGen"
    jvmArgs("-Djava.awt.headless=true")
    argumentProviders.add(CommandLineArgumentProvider { listOf(out.get().asFile.absolutePath) })
    outputs.dir(out)
}

val jpackageInput = tasks.register<Sync>("jpackageInput") {
    from(tasks.jar)
    into(layout.buildDirectory.dir("jpackage/input"))
}

// jpackage wants a plain number version (1.2.0); strip things like "-beta".
val appVersion = project.version.toString().substringBefore('-')
val iconFile = layout.buildDirectory.file(if (isWindows) "icons/icon.ico" else if (isMac) "icons/icon.icns" else "icons/icon.png")

fun jpackageArgs(type: String, dest: String): List<String> = buildList {
    addAll(listOf(jdkTool("jpackage"), "--type", type, "--dest", dest))
    addAll(listOf("--name", "JavaLens", "--app-version", appVersion, "--vendor", "JavaLens"))
    addAll(listOf("--description", "Live Java visualizer for teaching"))
    addAll(listOf("--input", layout.buildDirectory.dir("jpackage/input").get().asFile.absolutePath))
    addAll(listOf("--main-jar", "javalens.jar", "--main-class", "javalens.Main"))
    addAll(listOf("--runtime-image", layout.buildDirectory.dir("runtime").get().asFile.absolutePath))
    addAll(listOf("--icon", iconFile.get().asFile.absolutePath))
    if (type == "app-image") return@buildList
    when {
        isWindows -> addAll(listOf(
            "--win-menu", "--win-shortcut", "--win-dir-chooser", "--win-per-user-install",
            // Same id for every version, so installing a new version replaces the old one.
            "--win-upgrade-uuid", "7f1c2a9e-3b4d-4e8a-9a51-2c6d0e4b8f13",
        ))
        isMac -> addAll(listOf("--mac-package-name", "JavaLens"))
        else -> addAll(listOf(
            "--linux-package-name", "javalens", "--linux-shortcut",
            "--linux-menu-group", "Education", "--linux-app-category", "education",
        ))
    }
}

val appImage = tasks.register<Exec>("appImage") {
    description = "Builds the app folder (JavaLens with its own Java inside)"
    dependsOn(jpackageInput, jlinkRuntime, icons)
    val out = layout.buildDirectory.dir("jpackage/image")
    inputs.files(jpackageInput, jlinkRuntime, icons)
    outputs.dir(out)
    doFirst {
        delete(out)
        commandLine(jpackageArgs("app-image", out.get().asFile.absolutePath))
    }
}

val defaultInstallerType = when {
    isWindows -> "msi"
    isMac -> "dmg"
    File("/usr/bin/dpkg-deb").exists() -> "deb"
    else -> "rpm"
}
val installerType = providers.gradleProperty("installerType").orElse(defaultInstallerType)

val installer = tasks.register<Exec>("installer") {
    group = "distribution"
    description = "Builds the native installer for this OS into build/dist (override with -PinstallerType=...)"
    dependsOn(jpackageInput, jlinkRuntime, icons)
    val dest = layout.buildDirectory.dir("dist")
    doFirst {
        dest.get().asFile.mkdirs()
        commandLine(jpackageArgs(installerType.get(), dest.get().asFile.absolutePath))
    }
}

val osLabel = if (isWindows) "windows" else if (isMac) "macos" else "linux"
val portableName = "JavaLens-${project.version}-$osLabel-portable"

// Unzip-and-run: no install, no admin rights (handy on locked-down lab computers).
val portable = tasks.register("portable") {
    group = "distribution"
    description = "Packs the app folder into build/dist as a .zip (Windows/macOS) or .tar.gz (Linux)"
    dependsOn(if (isWindows || isMac) "portableZip" else "portableTar")
}
// Gradle 9 archives are "reproducible" by default, which resets every file to rw-r--r-- and would
// leave the launcher, bin/java and jspawnhelper unable to run. Keep the execute bit wherever the
// app folder has it.
fun AbstractArchiveTask.keepExecutableBits() {
    eachFile { if (file.canExecute()) permissions { unix("rwxr-xr-x") } }
}
tasks.register<Zip>("portableZip") {
    from(appImage)
    archiveFileName = "$portableName.zip"
    destinationDirectory = layout.buildDirectory.dir("dist")
    keepExecutableBits()
}
tasks.register<Tar>("portableTar") {
    from(appImage)
    compression = Compression.GZIP
    archiveFileName = "$portableName.tar.gz"
    destinationDirectory = layout.buildDirectory.dir("dist")
    keepExecutableBits()
}

// ---------------------------------------------------------------- VS Code extension (vscode/)
// The extension runs javalens.jar with the user's own JDK 25, so one .vsix works on every OS.

val vscodeNpmInstall = tasks.register<Exec>("vscodeNpmInstall") {
    description = "Installs the VS Code extension's build tools"
    workingDir = file("vscode")
    commandLine(npm, "ci", "--no-audit", "--no-fund")
    inputs.file("vscode/package-lock.json")
    outputs.file("vscode/node_modules/.package-lock.json")
}

val vscodeExtension = tasks.register<Exec>("vscodeExtension") {
    description = "Builds the VS Code extension into build/dist/javalens-<version>.vsix"
    group = "distribution"
    dependsOn(tasks.jar, vscodeNpmInstall, icons)
    val ver = project.version.toString()
    val vsix = layout.buildDirectory.file("dist/javalens-$ver.vsix")
    inputs.dir("vscode/src")
    inputs.files("vscode/package.json", "vscode/README.md", "vscode/tsconfig.json", "vscode/.vscodeignore")
    inputs.file(tasks.jar.flatMap { it.archiveFile })
    inputs.property("version", ver)
    outputs.file(vsix)
    workingDir = file("vscode")
    doFirst {
        // The server and icon ship inside the extension; the version follows the app's.
        copy { from(tasks.jar.flatMap { it.archiveFile }); into("vscode/server") }
        copy { from(layout.buildDirectory.file("icons/icon.png")); into("vscode") }
        vsix.get().asFile.parentFile.mkdirs()
    }
    commandLine(
        if (isWindows) "npx.cmd" else "npx", "--no-install", "@vscode/vsce", "package",
        "--skip-license", "--no-update-package-json", ver, "-o", vsix.get().asFile.absolutePath,
    )
}
