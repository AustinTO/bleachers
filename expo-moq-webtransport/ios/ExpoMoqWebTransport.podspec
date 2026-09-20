Pod::Spec.new do |s|
  s.name           = 'ExpoMoqWebTransport'
  s.version        = '0.1.0'
  s.summary        = 'Native WebTransport bridge for Expo/React Native and MoQT'
  s.description    = 'WebTransport over HTTP/3 with explicit WebTransport subprotocol negotiation.'
  s.author         = 'Puphr'
  s.homepage       = 'https://puphr.com'
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => 'https://example.invalid/expo-moq-webtransport.git', :tag => s.version.to_s }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'vendor/WebTransportFFI.xcframework'
end
