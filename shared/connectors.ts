export type GuideStep={title:string;detail:string;code?:string};
export type Connector={provider:'azure'|'aws'|'gcp';name:string;command:string;summary:string;steps:GuideStep[];permissions:{domain:string;items:string[]}[];notes:string[];docs:{label:string;url:string}[]};
export const connectors:Connector[]=[
  {provider:'azure',name:'Microsoft Azure',command:'az login',summary:'테넌트 루트에 읽기 권한을 가진 서비스 주체 하나로 모든 구독을 읽습니다.',
    steps:[
      {title:'서비스 주체 만들기',detail:'테넌트 루트 관리 그룹에 Reader를 주면 모든 구독에 상속되고 관리 그룹 계층도 읽힙니다. 이 범위에 할당하려면 관리 그룹 쪽 권한이 필요합니다.',code:'az ad sp create-for-rbac --name cloud-atlas-reader --role Reader \\\n  --scopes /providers/Microsoft.Management/managementGroups/<테넌트ID>'},
      {title:'비용 권한 추가',detail:'같은 범위에 비용 조회 역할을 줍니다.',code:'az role assignment create --assignee <appId> --role "Cost Management Reader" \\\n  --scope /providers/Microsoft.Management/managementGroups/<테넌트ID>'},
      {title:'서버에 자격 증명 설정',detail:'Azure에서 실행하면 관리 ID를 쓸 수 있어 비밀 값이 필요 없습니다.',code:'export AZURE_TENANT_ID=<테넌트ID>\nexport AZURE_CLIENT_ID=<appId>\nexport AZURE_CLIENT_SECRET=<비밀 값>'},
    ],
    permissions:[{domain:'리소스·네트워크',items:['Reader (Azure Resource Graph 포함)']},{domain:'IAM',items:['Reader로 역할 할당 조회','이름 표시: Microsoft Graph Directory.Read.All (없으면 ID로 표시)']},{domain:'비용',items:['Cost Management Reader']}],
    notes:['Reader를 구독에만 주면 수집은 되지만 관리 그룹 계층 없이 구독만 표시합니다.'],
    docs:[{label:'Resource Graph',url:'https://learn.microsoft.com/azure/governance/resource-graph/overview'},{label:'Cost Management API',url:'https://learn.microsoft.com/rest/api/cost-management/query'}]},
  {provider:'aws',name:'Amazon Web Services',command:'aws sso login --profile <프로필>\nexport AWS_PROFILE=<프로필>',summary:'시작 역할 하나가 조직 계정을 찾고, 계정마다 있는 읽기 역할로 전환합니다. 키 없이 워크로드 아이덴티티로 실행할 수 있습니다.',
    steps:[
      {title:'시작 역할 AtlasCollector 만들기',detail:'계정 목록과 조직 전체 비용을 읽어야 해서 관리(payer) 계정에 만듭니다. 위임 관리자 계정에 둘 수도 있지만, 조직 전체 비용은 관리 계정에서 조회해야 합니다. 이 역할은 자원을 직접 읽지 않습니다.',code:'{\n  "Version": "2012-10-17",\n  "Statement": [\n    {"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/AtlasReader"},\n    {"Effect": "Allow", "Action": ["organizations:Describe*", "organizations:List*", "ce:GetCostAndUsage"], "Resource": "*"}\n  ]\n}'},
      {title:'계정마다 읽기 역할 AtlasReader 배포',detail:'CloudFormation StackSets의 서비스 관리형 권한을 쓰면 새 계정에도 자동으로 만들어집니다. StackSets는 관리 계정에 배포하지 않으므로, 관리 계정의 자원도 볼 때는 직접 만듭니다.',code:'{\n  "Version": "2012-10-17",\n  "Statement": [{"Effect": "Allow", "Action": [\n    "ec2:Describe*", "elasticloadbalancing:Describe*", "rds:DescribeDBInstances",\n    "directconnect:Describe*", "eks:ListClusters", "eks:DescribeCluster",\n    "iam:List*", "resource-explorer-2:ListResources"\n  ], "Resource": "*"}]\n}'},
      {title:'서버에서 시작 역할 사용',detail:'EC2 인스턴스 프로파일, ECS 태스크 역할, EKS IRSA나 Pod Identity, OIDC 페더레이션, IAM Roles Anywhere 중 실행 위치에 맞는 방식을 고르면 키가 필요 없습니다.',code:'export ATLAS_AWS_ROLE_NAME=AtlasReader'},
    ],
    permissions:[{domain:'리소스·네트워크',items:['AtlasReader의 Describe 권한','나머지 서비스 목록: Resource Explorer 조직 인덱스']},{domain:'IAM',items:['iam:List*']},{domain:'비용',items:['관리 계정의 ce:GetCostAndUsage']}],
    notes:['Cost Explorer는 API 요청마다 과금합니다. 기본 하루 한 번만 조회합니다.','Organizations를 읽을 수 없으면 ATLAS_AWS_ACCOUNTS=이름=ID,이름=ID 로 계정을 지정합니다.'],
    docs:[{label:'StackSets',url:'https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html'},{label:'Cost Explorer API',url:'https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html'}]},
  {provider:'gcp',name:'Google Cloud',command:'gcloud auth application-default login',summary:'조직 수준 권한을 가진 서비스 계정 하나로 모든 폴더와 프로젝트를 읽습니다.',
    steps:[
      {title:'서비스 계정 만들고 API 켜기',detail:'이 프로젝트에서 API 사용량이 집계됩니다.',code:'gcloud iam service-accounts create cloud-atlas-reader --project <프로젝트>\ngcloud services enable cloudasset.googleapis.com cloudresourcemanager.googleapis.com bigquery.googleapis.com --project <프로젝트>'},
      {title:'조직에 읽기 권한 주기',detail:'조직 수준에 주어야 폴더 계층과 IAM 정책까지 읽힙니다.',code:'for ROLE in roles/cloudasset.viewer roles/browser roles/resourcemanager.organizationViewer; do\n  gcloud organizations add-iam-policy-binding <조직ID> \\\n    --member serviceAccount:cloud-atlas-reader@<프로젝트>.iam.gserviceaccount.com --role $ROLE\ndone'},
      {title:'비용: BigQuery 결제 내보내기 연결',detail:'GCP에는 금액을 바로 주는 조회 API가 없어 결제 내보내기를 씁니다. 콘솔의 결제 메뉴에서 표준 사용량 내보내기를 켠 뒤, 서비스 계정에 데이터셋 읽기와 작업 실행 권한을 줍니다.',code:'export ATLAS_GCP_BILLING_TABLE=<프로젝트>.<데이터셋>.<테이블>'},
      {title:'서버에 자격 증명 설정',detail:'GCP에서 실행하면 연결된 서비스 계정을, 외부에서는 워크로드 아이덴티티 제휴를 권장합니다. 키 파일은 레포 밖에 두세요.',code:'export GOOGLE_APPLICATION_CREDENTIALS=<자격 증명 파일 경로>'},
    ],
    permissions:[{domain:'리소스·네트워크',items:['roles/cloudasset.viewer','roles/browser']},{domain:'IAM',items:['roles/cloudasset.viewer (IAM 정책 포함)']},{domain:'비용',items:['결제 데이터셋의 roles/bigquery.dataViewer','프로젝트의 roles/bigquery.jobUser']}],
    notes:['BigQuery는 스캔한 데이터 양만큼 과금합니다. 기본 하루 한 번만 조회합니다.','결제 내보내기는 켠 시점 이후 데이터만 쌓입니다.'],
    docs:[{label:'Cloud Asset Inventory',url:'https://cloud.google.com/asset-inventory/docs/overview'},{label:'결제 데이터 내보내기',url:'https://cloud.google.com/billing/docs/how-to/export-data-bigquery'}]},
];
