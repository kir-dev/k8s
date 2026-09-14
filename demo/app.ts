import { Construct } from 'constructs';
import { App, Chart } from 'cdk8s';
import { KubeDeployment, KubeService, Quantity } from '../imports/k8s';

/**
 * A trivial cdk8s app that renders a Deployment + Service, proving that
 * ArgoCD can synthesize and apply cdk8s manifests through the `cdk8s`
 * Config Management Plugin.
 */
class DemoChart extends Chart {
  constructor(scope: Construct, ns: string) {
    super(scope, ns);

    const labels = { app: 'demo' };

    new KubeDeployment(this, 'demo-deployment', {
      metadata: { name: 'demo', labels },
      spec: {
        replicas: 2,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: 'demo',
                image: 'nginx:1.27.4',
                ports: [{ containerPort: 80 }],
                resources: {
                  requests: {
                    cpu: Quantity.fromString('10m'),
                    memory: Quantity.fromString('32Mi'),
                  },
                  limits: {
                    cpu: Quantity.fromString('100m'),
                    memory: Quantity.fromString('128Mi'),
                    'ephemeral-storage': Quantity.fromString('50Mi'),
                  },
                },
              },
            ],
          },
        },
      },
    });

    new KubeService(this, 'demo-service', {
      metadata: { name: 'demo', labels },
      spec: {
        selector: labels,
        ports: [{ port: 80, targetPort: 80 }],
      },
    });
  }
}

const app = new App();
new DemoChart(app, 'demo');

app.synth();
