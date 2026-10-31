import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:md_trust_live/main.dart';
import 'package:md_trust_live/l10n/language.dart';

void main() {
  // Exercise the native boundary without accessing real device keys.
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('unpaired device cannot start a live session', (tester) async {
    const channel = MethodChannel('org.mdsystem.md_trust_live/control');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (call) async => {'paired': false, 'running': false});
    try {
      await tester.pumpWidget(const TrustApp());
      await tester.pump();
      expect(find.text('Pair device'), findsOneWidget);
      expect(find.text('Start live session'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    } finally {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    }
  });
  testWidgets('manual language switches labels and never exposes server settings', (tester) async {
    // Exercise actual rendered widgets across every supported language.
    const channel = MethodChannel('org.mdsystem.md_trust_live/control');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (call) async => call.method == 'status' ? {'paired': false, 'running': false} : null);
    try {
      await tester.pumpWidget(const TrustApp());
      for (final language in AppLanguage.names.keys) {
        await AppLanguage.instance.select(language);
        await tester.pumpAndSettle();
        expect(find.text(tr('pair')), findsOneWidget);
        expect(find.text('EBS HTTPS address'), findsNothing);
        expect(find.text(tr('start')), findsNothing);
      }
      await tester.pumpWidget(const SizedBox());
    } finally {
      await AppLanguage.instance.select('auto');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    }
  });
}
