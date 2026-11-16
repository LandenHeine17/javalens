package javalens;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class AppInfoTest {
    @Test
    void versionsCompareNumerically() {
        assertTrue(AppInfo.compare("1.10.0", "1.9.3") > 0);
        assertTrue(AppInfo.compare("1.2", "1.2.1") < 0);
        assertEquals(0, AppInfo.compare("2.0.0", "2.0"));
    }

    @Test
    void noUpdateCheckWithoutARepo() {
        // gradle.properties ships with updateRepo empty, so nothing is newer.
        assertTrue(AppInfo.versionJson().contains("\"latest\":null"));
    }
}
