Pod::Spec.new do |s|
  s.name           = 'CordCallService'
  s.version        = '1.0.0'
  s.summary        = 'Twring incoming agent calls on iOS: PushKit, CallKit and notifications'
  s.description    = 'Twring incoming agent calls on iOS: PushKit, CallKit and notifications'
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
  s.frameworks = 'CallKit', 'PushKit', 'UserNotifications', 'AVFoundation'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
