//! GINA .gtp import tests: zip construction with the real zip crate,
//! regex/non-regex/timer trigger mapping, category paths from nested
//! groups, per-trigger skip warnings, and malformed-input errors.

use std::io::Write;

use eqlog_triggers::{import_gtp, Action, GinaImportError, TriggerEngine};

const SHARE_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<SharedData>
  <TriggerGroup>
    <Name>Imported</Name>
    <TriggerGroups>
      <TriggerGroup>
        <Name>Combat</Name>
        <Triggers>
          <Trigger>
            <Name>Enemy nuke</Name>
            <TriggerText>^(\w+) begins casting Cancelling of Life\.</TriggerText>
            <Comments>necro trash nuke</Comments>
            <EnableRegex>True</EnableRegex>
            <UseText>True</UseText>
            <DisplayText>{S1} is nuking!</DisplayText>
            <UseTextToVoice>True</UseTextToVoiceText>
            <TextToVoiceText>nuke incoming</TextToVoiceText>
            <TimerType>NoTimer</TimerType>
          </Trigger>
          <Trigger>
            <Name>Plain text stun</Name>
            <TriggerText>You are stunned! (ouch)</TriggerText>
            <EnableRegex>False</EnableRegex>
            <UseTextToVoice>True</UseTextToVoice>
            <TextToVoiceText>stunned</TextToVoiceText>
          </Trigger>
          <Trigger>
            <Name>Mez timer</Name>
            <TriggerText>^You begin casting Walking Sleep\.</TriggerText>
            <EnableRegex>True</EnableRegex>
            <TimerType>Timer</TimerType>
            <TimerName>Mez</TimerName>
            <TimerDuration>48</TimerDuration>
            <TimerEndingTime>6</TimerEndingTime>
          </Trigger>
        </Triggers>
      </TriggerGroup>
    </TriggerGroups>
  </TriggerGroup>
</SharedData>
"#;

fn valid_share_xml() -> String {
    // Fix the deliberately mismatched tag above so the constant reads as one
    // block; the mismatched version is reused by the malformed-xml test.
    SHARE_XML.replace("</UseTextToVoiceText>", "</UseTextToVoice>")
}

fn zip_bytes(name: &str, content: &str) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file::<_, ()>(name, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(content.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[test]
fn import_from_zip_maps_all_three_trigger_kinds() {
    let gtp = zip_bytes("ShareData.xml", &valid_share_xml());
    let import = import_gtp(&gtp).expect("valid gtp imports");
    assert!(import.warnings.is_empty(), "{:?}", import.warnings);
    assert_eq!(import.triggers.len(), 3);

    // Regex trigger: pattern kept verbatim, category from the group path,
    // GINA {S1} display token converted to ${S1}.
    let nuke = &import.triggers[0];
    assert_eq!(nuke.name, "Enemy nuke");
    assert_eq!(nuke.pattern, r"^(\w+) begins casting Cancelling of Life\.");
    assert_eq!(nuke.category.as_deref(), Some("Imported/Combat"));
    assert_eq!(nuke.comments.as_deref(), Some("necro trash nuke"));
    assert!(nuke.actions.contains(&Action::DisplayText {
        template: "${S1} is nuking!".into()
    }));
    assert!(nuke.actions.contains(&Action::Speak {
        template: "nuke incoming".into()
    }));

    // Non-regex trigger: TriggerText regex-escaped.
    let stun = &import.triggers[1];
    assert_eq!(stun.pattern, r"You are stunned! \(ouch\)");
    assert_eq!(
        stun.actions,
        vec![Action::Speak {
            template: "stunned".into()
        }]
    );

    // Timer trigger.
    let mez = &import.triggers[2];
    assert_eq!(
        mez.actions,
        vec![Action::StartTimer {
            name: "Mez".into(),
            duration_secs: 48,
            warn_at_secs: Some(6),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            lane: None,
        }]
    );

    // Everything imported must actually compile in the engine.
    let engine = TriggerEngine::new(import.triggers, "Nyasha");
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());
    assert_eq!(engine.active_trigger_count(), 3);
}

#[test]
fn import_accepts_bare_xml() {
    let import = import_gtp(valid_share_xml().as_bytes()).expect("bare xml imports");
    assert_eq!(import.triggers.len(), 3);
}

#[test]
fn bad_trigger_is_skipped_with_warning_others_survive() {
    let xml = r#"<SharedData>
      <TriggerGroup>
        <Name>G</Name>
        <Triggers>
          <Trigger>
            <Name>Broken regex</Name>
            <TriggerText>([unclosed</TriggerText>
            <EnableRegex>True</EnableRegex>
          </Trigger>
          <Trigger>
            <Name>Fine</Name>
            <TriggerText>You died\.</TriggerText>
            <EnableRegex>True</EnableRegex>
            <UseTextToVoice>True</UseTextToVoice>
            <TextToVoiceText>dead</TextToVoiceText>
          </Trigger>
          <Trigger>
            <TriggerText>nameless</TriggerText>
          </Trigger>
        </Triggers>
      </TriggerGroup>
    </SharedData>"#;
    let import = import_gtp(xml.as_bytes()).expect("document itself is well-formed");
    assert_eq!(import.triggers.len(), 1);
    assert_eq!(import.triggers[0].name, "Fine");
    assert_eq!(import.warnings.len(), 2);
    assert!(import.warnings.iter().any(|w| w.contains("Broken regex")));
    assert!(import.warnings.iter().any(|w| w.contains("missing Name")));
}

#[test]
fn malformed_zip_is_error_not_panic() {
    // PK magic but garbage after it.
    let bogus = b"PK\x03\x04this is not a real zip archive at all";
    let err = import_gtp(bogus).unwrap_err();
    assert!(matches!(err, GinaImportError::Archive(_)));
}

#[test]
fn malformed_xml_is_error_not_panic() {
    // Mismatched close tag (the raw SHARE_XML constant has one on purpose).
    let err = import_gtp(SHARE_XML.as_bytes()).unwrap_err();
    assert!(matches!(err, GinaImportError::Xml(_)));

    // Not XML at all.
    let err = import_gtp(b"just some text").unwrap_err();
    assert!(matches!(err, GinaImportError::Archive(_)));

    // Zip containing broken XML.
    let gtp = zip_bytes("ShareData.xml", "<SharedData><Trigger></SharedData>");
    let err = import_gtp(&gtp).unwrap_err();
    assert!(matches!(err, GinaImportError::Xml(_)));
}

#[test]
fn zip_without_xml_is_error() {
    let gtp = zip_bytes("readme.txt", "no triggers here");
    let err = import_gtp(&gtp).unwrap_err();
    assert!(matches!(err, GinaImportError::Archive(_)));
}

#[test]
fn empty_input_is_error() {
    assert!(import_gtp(b"").is_err());
}
