# 前端目录（Vue3 + TypeScript + Pinia）
frontend/
├── .env.development
├── .env.production
├── tsconfig.json
├── vite.config.ts
├── package.json
├── public/
├── src/
    ├── main.ts
    ├── App.vue
    ├── api/
    │   ├── moduleA.ts
    │   ├── moduleB.ts
    │   └── types/api.d.ts
    ├── mock/
    │   ├── index.ts
    │   ├── interceptor.ts
    │   └── modules/
    │       ├── moduleA.ts
    │       └── moduleB.ts
    ├── stores/
    │   ├── moduleA.ts
    │   └── moduleB.ts
    ├── router/
    │   ├── index.ts
    │   └── guard.ts
    ├── views/
    │   ├── moduleA/
    │   │   ├── index.vue
    │   │   └── components/
    │   └── moduleB/
    ├── components/
    │   ├── Table/
    │   ├── SearchForm/
    │   └── Layout/
    ├── hooks/
    │   ├── useTable.ts
    │   └── useSearch.ts
    ├── utils/
    │   ├── request.ts
    │   ├── storage.ts
    │   ├── format.ts
    │   └── validate.ts
    ├── constants/
    │   └── dict.ts
    └── assets/
        ├── style/
        └── images/

# 后端目录（SpringBoot 参考COLA DDD 分层）
src/main/java/com/company/base
├── boot
│   ├── XxxApplication.java
│   └── config
│       ├── WebConfig.java
│       ├── MyBatisConfig.java
│       └── FeignConfig.java
├── adapter
│   ├── rest
│   │   └── moduleA
│   │       └── XxxController.java
│   ├── consumer
│   │   └── moduleA
│   │       └── XxxMsgConsumer.java
│   └── scheduler
│       └── moduleA
│           └── XxxTask.java
├── application
│   ├── dto
│   │   ├── req
│   │   │   └── XxxQueryReq.java
│   │   └── resp
│   │       └── XxxRespDTO.java
│   ├── converter
│   │   └── XxxAppConverter.java
│   ├── service
│   │   ├── XxxAppService.java
│   │   └── process
│   │       └── XxxProcess.java
│   ├── repository/facade
│   │   └── XxxRepositoryFacade.java
│   ├── external
│   │   └── IXxxExternalService.java
│   └── error
│       └── AppErrorCodeEnum.java
├── domain
│   ├── moduleA // 聚合根A
│   │   ├── entity
│   │   │   ├── Xxx.java          // 聚合根实体
│   │   │   └── XxxRecordVO.java  // 值对象
│   │   ├── event
│   │   │   └── XxxCreateEvent.java
│   │   ├── repository
│   │   │   └── IXxxRepository.java
│   │   ├── enums
│   │   │   └── XxxStatusEnum.java
│   │   ├── constants
│   │   ├── error
│   │   │   └── XxxDomainErrorEnum.java
│   │   └── properties
│   └── moduleB // 聚合根B，结构同moduleA
└── infrastructure
    ├── repository
    │   ├── moduleA
    │   │   ├── dao
    │   │   │   └── XxxDao.java
    │   │   ├── dataobject
    │   │   │   └── XxxDO.java
    │   │   ├── cache
    │   │   │   └── XxxCache.java
    │   │   ├── storage
    │   │   ├── converter
    │   │   │   └── XxxInfraConverter.java
    │   │   └── XxxRepository.java // IXxxRepository实现类
    │   └── moduleB // 结构同moduleA
    └── external // 第三方防腐层
        ├── third-center-a
        │   ├── dto
        │   │   ├── req/XxxQueryReq.java
        │   │   └── resp/XxxRespDTO.java
        │   ├── converter
        │   │   └── XxxExternalConverter.java
        │   ├── feign
        │   │   └── IXxxFeignClient.java
        │   ├── error
        │   │   └── ThirdErrorEnum.java
        │   ├── properties
        │   │   └── XxxExternalProperties.java
        │   └── XxxExternalServiceImpl.java // 实现application层IXxxExternalService
        └── third-storage // 对象存储第三方，结构同上