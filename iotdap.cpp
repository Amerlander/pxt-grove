#include "pxt.h"

// RAM-Ablage für die IoT-Erweiterung — die USB-Hälfte des Protokolls aus iot.ts.
//
// WARUM: Über das USB-Kabel hat sich die serielle Leitung für diese Daten als
// unzuverlässig erwiesen. Der Empfangspuffer fasst per Vorgabe 20 Byte
// (CODAL_SERIAL_DEFAULT_BUFFER_SIZE) — weniger als eine einzige Protokollzeile
// —, und ihn zu vergrößern hat das Senden zerschossen. Über USB nimmt der Host
// darum denselben Weg, den die Blocks-Laufzeit und Jacdac längst gehen: Er
// liest und schreibt eine Struktur in unserem RAM über den Debug-Port
// (CMSIS-DAP), OHNE den Kern anzuhalten. Das Gerät merkt davon nichts außer
// zwei Zahlen, die sich unter ihm ändern.
//
// Hier steht nur das Nötigste: die Struktur und drei Zugriffe. Kein Fiber,
// keine Unterbrechung, keine Speicheranforderung — getaktet wird im
// TypeScript-Fiber von iot.ts, der ohnehin alle 100 ms läuft.
//
// ── Vertrag mit dem Host (lib/mini-connection-widget) ────────────────────────
// Die Abstände liegen fest; die Gegenseite sucht die Struktur an ihren beiden
// Magic-Wörtern und spricht die Felder über feste Abstände an. Wer hier etwas
// verschiebt, bricht drüben:
//
//   0    u32  magic0
//   4    u32  magic1
//   8    u32  info        Byte 8 = irqn, Byte 9..11 frei (0)
//   12   u32  inboundHead Byte 2 des Wortes = Länge, 0 = leer   (Gerät -> Host)
//   16   ...  inbound     bis zu 252 Byte
//   268  u32  sendHead    Byte 2 = Länge, 0 = Platz frei        (Host -> Gerät)
//   272  ...  send        bis zu 64 Byte
//
// Ein Platz trägt GENAU EINE Zeile in latin1, ohne Zeilenende — dieselben
// "IOT1:"-Zeilen, die iot.ts auch auf die serielle Leitung schreibt. Die
// englischen Feldnamen sind Absicht: So heißen sie auf der Host-Seite, und ein
// zweiter Name für dasselbe Feld kostet beim Nachlesen mehr, als er einbringt.
//
// Die Längenbytes sind das ganze Protokoll: Wer schreibt, setzt die Länge
// zuletzt; wer liest, setzt sie zurück auf 0. Mehr Handschlag gibt es nicht,
// und mehr braucht ein Platz für eine Zeile auch nicht.

// "IoTC" und "Line" (im Speicher als Bytes: "CToI" / "eniL"). Eigene Wörter,
// damit ein Host niemals eine Jacdac- (0x786d444a/0xb0a6c0e9) oder
// Blocks-Ablage (0x426c6f63/0x4d61696c) für unsere hält.
#define IOTDAP_MAGIC0 0x496f5443u
#define IOTDAP_MAGIC1 0x4c696e65u

// Was im info-Wort steht. Wir schalten KEINE Unterbrechung ein — gefragt wird
// aus dem TypeScript-Fiber. Gemeldet wird trotzdem SWI0_EGU0 (20) und nicht 0:
// Der Host stößt die gemeldete Nummer nach jeder Übertragung an (heute
// abgeschaltet), und eine abgeschaltete SWI-Leitung anzustoßen ist folgenlos —
// die 0 wäre dagegen POWER_CLOCK und damit ein echter Interrupt des SoftDevice.
#define IOTDAP_IRQN 20

#define IOTDAP_INBOUND_BODY 252
#define IOTDAP_SEND_BODY 64

// Nur auf dem mini 3 (codal/nRF52). Auf dem mini 2 gibt es diesen Weg nicht:
// Dort sitzt ein SEGGER J-Link, der dem Host Flashen und eine serielle Leitung
// anbietet, aber keinen Speicherzugriff — und 16 KB RAM sind zu wenig, um 336
// Byte plus bis zu 1 KB Ausrichtung für einen Briefkasten zu verschenken, den
// niemand leert. Die drei Einsprünge unten gibt es trotzdem in jedem Bau (sonst
// fehlten dem Linker die Shims); sie antworten dort mit „nichts da", und iot.ts
// bleibt auf der seriellen Leitung.
#if MICROBIT_CODAL

#include <cstddef>

struct IotDapExchange {
    uint32_t magic0;
    uint32_t magic1;
    uint32_t info;
    // volatile, weil der Host diesen Speicher unter dem laufenden Kern ändert:
    // Die beiden Kopfwörter sind zugleich die Ampeln des Handschlags, und der
    // Compiler darf sie weder wegoptimieren noch umsortieren.
    volatile uint32_t inboundHead;
    volatile uint8_t inbound[IOTDAP_INBOUND_BODY];
    volatile uint32_t sendHead;
    volatile uint8_t send[IOTDAP_SEND_BODY];
};

// Der Vertrag als Übersetzungsfehler statt als stiller Leitungsbruch: Wer ein
// Feld einfügt oder umstellt, merkt es hier und nicht erst daran, dass der
// Campus Unsinn anzeigt.
static_assert(offsetof(IotDapExchange, inboundHead) == 12, "inboundHead gehört auf +12");
static_assert(offsetof(IotDapExchange, inbound) == 16, "inbound gehört auf +16");
static_assert(offsetof(IotDapExchange, sendHead) == 268, "sendHead gehört auf +268");
static_assert(offsetof(IotDapExchange, send) == 272, "send gehört auf +272");
static_assert(sizeof(IotDapExchange) == 336, "die Ablage ist 336 Byte groß");

// Die Struktur selbst. Statisch, damit sie an einer festen Adresse liegt;
// „used", damit der Linker sie nicht wegräumt, weil scheinbar niemand sie
// braucht. Ohne Vorbelegung landet sie im .bss und damit hinter dem .data —
// ein Stück weiter weg von der geschützten Ecke des SoftDevice.
//
// aligned(1024) ist kein Schönheitswunsch: Der Host tastet das RAM in
// 1-KB-Blöcken ab und darf dabei NICHT unter den Beginn des Anwendungs-RAM
// greifen — was darunter liegt, gehört dem SoftDevice, ist geschützt, und ein
// Lesezugriff darauf über den Debug-Port lässt das Gerät abstürzen. Auf einer
// 1-KB-Grenze ab 0x20002400 liegt die Struktur in einem Block, den er ganz
// lesen darf.
static IotDapExchange dapAblage __attribute__((used, aligned(1024)));

// Erst wenn das Programm die Ablage wirklich benutzt, tragen wir die
// Magic-Wörter ein. Vorher steht dort nur 0 und der Host findet schlicht nichts
// — genau richtig für ein Programm ohne IoT-Blöcke.
static bool bereit;
// Wir haben eine Zeile hingelegt, die noch niemand abgeholt hat.
static bool armiert;
// Irgendwann hat der Host einmal etwas abgeholt oder hingelegt. Das ist das
// einzige Lebenszeichen, das das Gerät von der anderen Seite bekommt.
static bool hostGesehen;

static void ablageBereiten() {
    if (bereit) return;
    bereit = true;
    dapAblage.info = IOTDAP_IRQN;
    dapAblage.inboundHead = 0;
    dapAblage.sendHead = 0;
    // Reihenfolge: erst die Felder, dann die Unterschrift. Der Host sucht
    // dauernd; fände er die Magic-Wörter, während die Köpfe noch Müll sind,
    // läse er Müll als Zeile.
    __asm__ volatile("" ::: "memory");
    dapAblage.magic0 = IOTDAP_MAGIC0;
    dapAblage.magic1 = IOTDAP_MAGIC1;
}

// Hat der Host die zuletzt hingelegte Zeile inzwischen geholt? Erkennbar ist
// das nur daran, dass die Länge, die WIR gesetzt haben, wieder 0 ist.
static void ablagePruefen() {
    if (armiert && ((dapAblage.inboundHead >> 16) & 0xff) == 0) {
        armiert = false;
        hostGesehen = true;
    }
}

static bool ablageSchreiben(const char *daten, uint32_t laenge) {
    ablageBereiten();
    ablagePruefen();
    if (!daten || laenge == 0 || laenge > IOTDAP_INBOUND_BODY) return false;
    // Platz noch belegt: Der Host hat die vorige Zeile nicht geholt. Nicht
    // warten und schon gar nicht überschreiben — er könnte gerade mitten im
    // Lesen sein. Ob und wie lange gewartet wird, entscheidet iot.ts.
    if (((dapAblage.inboundHead >> 16) & 0xff) != 0) return false;
    for (uint32_t i = 0; i < laenge; i++) dapAblage.inbound[i] = (uint8_t)daten[i];
    // Erst der Inhalt, dann die Länge: Die Länge ist die Ampel.
    __asm__ volatile("" ::: "memory");
    dapAblage.inboundHead = (uint32_t)(laenge & 0xff) << 16;
    armiert = true;
    return true;
}

static uint32_t ablageLesen(char *ziel) {
    ablageBereiten();
    ablagePruefen();
    uint32_t laenge = (dapAblage.sendHead >> 16) & 0xff;
    if (laenge == 0) return 0;
    if (laenge > IOTDAP_SEND_BODY) laenge = IOTDAP_SEND_BODY;
    // Erst die Länge lesen, dann den Inhalt, dann freigeben.
    __asm__ volatile("" ::: "memory");
    for (uint32_t i = 0; i < laenge; i++) ziel[i] = (char)dapAblage.send[i];
    __asm__ volatile("" ::: "memory");
    dapAblage.sendHead = 0;
    // Wer schreibt, liest auch: Eine Zeile vom Host ist der deutlichste Beweis,
    // dass jemand am Debug-Port hängt.
    hostGesehen = true;
    return laenge;
}

static bool ablageHostGesehen() {
    ablagePruefen();
    return hostGesehen;
}

#else

static bool ablageSchreiben(const char *daten, uint32_t laenge) {
    return false;
}

static uint32_t ablageLesen(char *ziel) {
    return 0;
}

static bool ablageHostGesehen() {
    return false;
}

#endif

namespace iotdap {

// Legt eine Zeile für den Host hin. false heißt: Der Platz ist noch belegt, die
// Zeile wurde NICHT übernommen.
//%
bool schreibe(String zeile) {
    if (!zeile) return false;
    return ablageSchreiben(zeile->getUTF8Data(), zeile->getUTF8Size());
}

// Holt die Zeile des Hosts und gibt den Platz frei. Leerer Text heißt: nichts da.
//%
String lies() {
    char puffer[IOTDAP_SEND_BODY];
    uint32_t laenge = ablageLesen(puffer);
    if (laenge == 0) return mkString("", 0);
    return mkString(puffer, laenge);
}

// Hat der Host jemals eine Zeile abgeholt oder hingelegt?
//%
bool hoertJemandZu() {
    return ablageHostGesehen();
}

} // namespace iotdap
