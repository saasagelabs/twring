Pod::Spec.new do |s|
  s.name           = 'TwringAudioRoute'
  s.version        = '1.0.0'
  s.summary        = 'Twring call audio route changes and interruptions on iOS'
  s.description    = 'Twring call audio route changes and interruptions on iOS'
  s.license        = 'UNLICENSED'
  s.author         = 'SaasAge Labs'
  s.homepage       = 'https://twring.com'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/saasagelabs/twring-CORD-.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
