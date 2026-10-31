import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'messages.dart';

class AppLanguage extends ChangeNotifier with WidgetsBindingObserver {
  static final instance = AppLanguage();
  static const names = {'en':'English','es':'Español','de':'Deutsch','fr':'Français','ru':'Русский','uk':'Українська','ja':'日本語'};
  static const channel = MethodChannel('org.mdsystem.md_trust_live/control');
  String preference = 'auto';

  Future<void> initialize() async {
    // Native preferences persist without introducing an additional storage plugin.
    WidgetsBinding.instance.addObserver(this);
    try { final saved = await channel.invokeMethod<String>('getLanguage'); preference = names.containsKey(saved) ? saved! : 'auto'; }
    catch (_) { preference = 'auto'; }
  }

  String get code {
    // Respect OS language order and normalize regional variants to the supported base.
    if (names.containsKey(preference)) return preference;
    for (final locale in WidgetsBinding.instance.platformDispatcher.locales) {
      if (names.containsKey(locale.languageCode)) return locale.languageCode;
    }
    return 'en';
  }

  Future<void> select(String value) async {
    // Switch immediately; a storage failure must not disable the current session choice.
    preference = names.containsKey(value) ? value : 'auto'; notifyListeners();
    try { await channel.invokeMethod<void>('setLanguage', {'language':preference}); }
    catch (_) { debugPrint('Language preference could not be persisted'); }
  }

  @override
  void didChangeLocales(List<Locale>? locales) {
    // Update automatic selection when Android changes its language while the app is open.
    if (preference == 'auto') notifyListeners();
  }
}

String tr(String key, [Object value = '']) {
  // User-provided values remain plain text and cannot alter the catalog.
  final index = AppLanguage.names.keys.toList().indexOf(AppLanguage.instance.code);
  return (messages[key] ?? messages['unavailable']!)[index].replaceAll('{value}', '$value');
}
