/**
 * RAM-Ablage — der USB-Weg für die Zeilen aus iot.ts, unter Umgehung der
 * seriellen Leitung.
 *
 * Über USB liest und schreibt der Campus eine kleine Struktur in unserem RAM
 * über den Debug-Port (CMSIS-DAP), ohne den Kern anzuhalten — genau so, wie es
 * die Blocks-Laufzeit und Jacdac längst tun. Der Grund ist der 20 Byte kleine
 * Empfangspuffer der seriellen Leitung, in den nicht einmal eine ganze
 * Protokollzeile passt; ihn zu vergrößern hat das Senden zerschossen.
 *
 * Hier stehen nur die Verbindungen zum C++ (iotdap.cpp). Die Zeilenkörper sind
 * das, was im SIMULATOR läuft: Dort gibt es keinen Debug-Port und keine
 * Ablage, also antwortet alles mit „nichts da" — und iot.ts fällt automatisch
 * auf die serielle Leitung zurück, ohne eine einzige Abfrage mehr.
 *
 * Ein Platz je Richtung, eine Zeile je Platz, Längenbyte als Ampel. Der ganze
 * Vertrag samt Abständen steht in iotdap.cpp.
 */
namespace iotdap {

    /**
     * Legt eine Zeile für den Host hin (Gerät → Host), latin1, ohne Zeilenende.
     *
     * Gibt false zurück, wenn der Platz noch die vorige Zeile trägt — der Host
     * hat sie dann noch nicht geholt. Absichtlich wird hier NICHT gewartet und
     * nicht überschrieben: Wie dringend eine Zeile ist, weiß nur der Aufrufer.
     */
    //% shim=iotdap::schreibe
    export function schreibe(zeile: string): boolean {
        return false
    }

    /**
     * Holt die Zeile des Hosts (Host → Gerät) und gibt den Platz wieder frei.
     * Leerer Text heißt: Es lag nichts da.
     */
    //% shim=iotdap::lies
    export function lies(): string {
        return ""
    }

    /**
     * Hat der Host jemals eine Zeile abgeholt oder hingelegt?
     *
     * Das einzige Lebenszeichen, das dieser Weg hergibt: Ein Gerät kann nicht
     * sehen, ob ein Debugger am Kabel hängt — es sieht nur, dass jemand die
     * Länge zurückgesetzt hat, die es selbst gesetzt hatte.
     */
    //% shim=iotdap::hoertJemandZu
    export function hoertJemandZu(): boolean {
        return false
    }
}
