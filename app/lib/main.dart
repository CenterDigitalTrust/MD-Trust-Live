import 'dart:async';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'l10n/language.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppLanguage.instance.initialize();
  // Keep presentation separate from native signing and foreground work.
  runApp(const TrustApp());
}

class TrustApp extends StatelessWidget {
  const TrustApp({super.key});
  @override
  Widget build(BuildContext context) {
    // Match the Twitch panel while preserving readable mobile typography.
    return AnimatedBuilder(animation: AppLanguage.instance, builder: (context, _) => MaterialApp(
      locale: Locale(AppLanguage.instance.code),
      supportedLocales: AppLanguage.names.keys.map((code) => Locale(code)),
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      title: 'MD Trust Live',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: const Color(0xff18181b),
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff9146ff), brightness: Brightness.dark),
      ),
      home: const SessionScreen(),
    ));
  }
}

class SessionScreen extends StatefulWidget {
  const SessionScreen({super.key});
  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  static const channel = MethodChannel('org.mdsystem.md_trust_live/control');
  static const serverUrl = String.fromEnvironment('EBS_URL', defaultValue: 'https://api.digitaltrust.living/twitch');
  final code = TextEditingController();
  final prize = TextEditingController();
  Timer? timer;
  Map<dynamic, dynamic> status = {};
  String? error;
  bool busy = false;

  @override
  void initState() {
    // Poll native operational state without signing in the UI isolate.
    super.initState();
    refresh();
    timer = Timer.periodic(const Duration(seconds: 2), (_) => refresh());
  }

  Future<void> refresh() async {
    // Platform failures remain visible and never imply a live verified stream.
    try {
      final result = await channel.invokeMapMethod<dynamic, dynamic>('status');
      if (mounted) setState(() => status = result ?? {});
    } on PlatformException {
      if (mounted) setState(() => error = tr('failed'));
    } catch (e) {
      if (mounted) setState(() => error = tr('failed'));
    }
  }

  Future<void> action(String method) async {
    // Serialize user actions and show errors without losing entered settings.
    setState(() { busy = true; error = null; });
    try {
      await channel.invokeMethod<void>(method, method == 'pair' ? {'url': serverUrl, 'code': code.text.trim()} : method == 'giveawayOpen' ? {'prize': prize.text.trim()} : null);
      await refresh();
    } on PlatformException catch (e) {
      if (mounted) setState(() => error = e.code == 'NOTIFICATION_PERMISSION' ? tr('notify') : tr('failed'));
    } catch (e) {
      if (mounted) setState(() => error = tr('failed'));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    // Dispose only UI resources; explicit Stop controls the foreground session.
    timer?.cancel(); code.dispose(); prize.dispose(); super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Display acknowledged activity, not an unsupported video-authenticity claim.
    final running = status['running'] == true;
    final paired = status['paired'] == true;
    return Scaffold(
      appBar: AppBar(title: const Text('MD TRUST LIVE')),
      body: SafeArea(child: ListView(padding: const EdgeInsets.all(24), children: [
        DropdownButtonFormField<String>(value: AppLanguage.instance.preference, isExpanded: true, decoration: InputDecoration(labelText: tr('language')), onChanged: (value) { if (value != null) AppLanguage.instance.select(value); }, items: [DropdownMenuItem(value: 'auto', child: Text(tr('auto'))), ...AppLanguage.names.entries.map((entry) => DropdownMenuItem(value: entry.key, child: Text(entry.value)))]),
        const SizedBox(height: 20),
        Icon(Icons.shield_outlined, size: 96, color: running ? const Color(0xff52e7a7) : const Color(0xffb491ff)),
        const SizedBox(height: 16),
        Text(running ? tr('active') : tr('tagline'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        Text(tr('intro'), textAlign: TextAlign.center),
        const SizedBox(height: 28),
        if (!running) ...[
          TextField(controller: code, keyboardType: TextInputType.number, maxLength: 6, inputFormatters: [FilteringTextInputFormatter.digitsOnly], decoration: InputDecoration(labelText: tr('pairCode'), border: const OutlineInputBorder())),
          OutlinedButton.icon(onPressed: busy ? null : () => action('pair'), icon: const Icon(Icons.link), label: Text(paired ? tr('repair') : tr('pair'))),
        ],
        if (paired) ...[
          const SizedBox(height: 16),
          FilledButton.icon(onPressed: busy ? null : () => action(running ? 'stop' : 'start'), icon: Icon(running ? Icons.stop_circle_outlined : Icons.play_arrow), label: Text(running ? tr('stop') : tr('start'))),
          const SizedBox(height: 16),
          Card(child: Padding(padding: const EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(tr('channel', status['channel'] ?? '')), const SizedBox(height: 8),
            Text('${tr('events')}: ${status['seq'] ?? 0}'), const SizedBox(height: 8),
            Text(tr(running ? 'active' : 'ready')), const SizedBox(height: 12),
            SelectableText('${status['hash'] ?? ''}', style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
          ]))),
        ],
        if (busy) const LinearProgressIndicator(),
        if (running) ...[
          const SizedBox(height: 20),
          Text(tr('drop'), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 10),
          TextField(controller: prize, maxLength: 200, decoration: InputDecoration(labelText: tr('prize'), border: const OutlineInputBorder())),
          Text(tr('${status['giveaway_phase'] ?? 'NONE'}')),
          Wrap(spacing: 8, children: [
            OutlinedButton(onPressed: busy ? null : () => action('giveawayOpen'), child: Text(tr('open'))),
            OutlinedButton(onPressed: busy ? null : () => action('giveawayLock'), child: Text(tr('lock'))),
            FilledButton(onPressed: busy ? null : () => action('giveawayDraw'), child: Text(tr('draw'))),
          ]),
          Text(status['giveaway_phase'] == 'COMPLETE' ? tr('winner', '${status['giveaway_result'] ?? ''}'.replaceFirst('Winner: ', '')) : ''),
        ],
        if (error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text(error!, style: const TextStyle(color: Color(0xffff8299)))),
        const SizedBox(height: 24),
        Text(tr('honesty'), style: const TextStyle(color: Colors.grey, fontSize: 12)),
      ])),
    );
  }
}
