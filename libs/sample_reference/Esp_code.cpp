#include "commands.h"
#include "config.h"
#include "motor.h"
#include "loadcell.h"
#include "calibration.h"
#include "test.h"

// Defined in main.cpp
extern HardwareSerial PROTO;

// External globals (must be defined in respective modules)
extern float pulses_per_mm;
extern long distZeroPulses;
extern bool distCalOK;
extern bool loadCalOK;

extern float lastMeasuredDistance;
extern float lastHardnessPeak;
extern bool lastHardnessBroken;

// Validation control
bool loadValidationActive = false;
unsigned long lastValMillis = 0;

void initCommandProcessor() {
    loadValidationActive = false;
    lastValMillis = 0;
}

void processCommand(String cmd) {

    cmd.trim();  // Important for serial reliability

    if (cmd == "S,PING*") {
        PROTO.println("S,OK*");
    }

    else if (cmd == "C,TARE*") {
        tareLoadCell();
        PROTO.println("C,TARE,OK*");
    }

    else if (cmd == "C,LOAD*") {
        if (calibrateLoadCell()) {
            PROTO.println("C,LOAD,OK*");
        } else {
            PROTO.println("C,LOAD,ERR*");
        }
    }

    else if (cmd == "C,DZ*") {
        distanceZero();
        if (distZeroPulses > 0) {
            PROTO.printf("C,DZ,OK,%ld*\n", distZeroPulses);
        } else {
            PROTO.println("C,DZ,ERR*");
        }
    }

    else if (cmd == "C,DS*") {
        distanceSpan();
        if (distCalOK) {
            PROTO.printf("C,DS,OK,%.3f*\n", pulses_per_mm);
        } else {
            PROTO.println("C,DS,ERR*");
        }
    }

    else if (cmd.startsWith("T,BO,")) {
        int endIdx = cmd.indexOf('*');
        float mm = (endIdx > 5) ? cmd.substring(5, endIdx).toFloat() : 0.0f;
        testBackoffMove(mm);
        PROTO.println("T,BO,OK*");
    }

    else if (cmd == "T,DIM*") {
        startDimensionTest();
        PROTO.printf("D,DIM,%.3f*\n", lastMeasuredDistance);
    }

    else if (cmd == "T,HARD*") {
        startHardnessTest();
        PROTO.printf("D,HARD,%.2f,%s*\n",
                     lastHardnessPeak,
                     lastHardnessBroken ? "BROK" : "MAX");
    }

    else if (cmd == "T,HOME*") {
        homeAxis();
        PROTO.println("T,HOME,OK*");
    }

    else if (cmd == "V,L,1*") {
        loadValidationActive = true;
        PROTO.println("V,L,1*");
    }

    else if (cmd == "V,L,0*") {
        loadValidationActive = false;
        PROTO.println("V,L,0*");
    }

    else {
        PROTO.println("E,UNK*");
    }
}

void streamLoadValidation() {

    if (!loadValidationActive) return;
    if (!loadCalOK) return;
    if (millis() - lastValMillis < VAL_INTERVAL_MS) return;

    lastValMillis = millis();

    float g = getForceGramSafe();

    if (g >= 0) {
        PROTO.printf("V,L,G,%.2f*\n", g);
    } else {
        PROTO.println("V,L,G,ERR*");
    }
}
