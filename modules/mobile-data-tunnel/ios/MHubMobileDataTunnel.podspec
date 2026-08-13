require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MHubMobileDataTunnel'
  s.version = package['version']
  s.summary = 'Foreground-only native data tunnel for MHub Agent'
  s.description = s.summary
  s.license = 'UNLICENSED'
  s.author = 'MHub'
  s.homepage = 'https://github.com/dytoutsea/mhub-agent'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/dytoutsea/mhub-agent.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
